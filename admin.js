const usersBody = document.querySelector("#users-body");
const usersStatus = document.querySelector("#users-status");
const createError = document.querySelector("#create-error");
const credentialBox = document.querySelector("#new-credentials");
const toast = document.querySelector("#toast");

let me = null;
let toastTimer;

const dateFormatter = new Intl.DateTimeFormat("da-DK", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
});

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4000);
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers
  });
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("unauthenticated");
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) throw new Error(payload.error || `Fejl ${response.status}`);
  return payload;
}

// Shown once, never retrievable again — make that obvious rather than a toast
// that disappears before it can be written down.
function showCredentials(username, password) {
  credentialBox.hidden = false;
  credentialBox.innerHTML = `
    <strong>Adgangskode for ${escapeHTML(username)}</strong>
    <code>${escapeHTML(password)}</code>
    <p>Vises kun nu. Giv den til brugeren — den skal skiftes ved første login.</p>
    <button type="button" class="header-button" data-copy="${escapeHTML(password)}">Kopiér</button>
  `;
}

function actionsFor(user) {
  const isSelf = user.id === me?.id;
  const buttons = [
    `<button type="button" data-action="reset" data-id="${user.id}">Nulstil kode</button>`,
    `<button type="button" data-action="revoke" data-id="${user.id}">Log ud alle enheder</button>`
  ];
  if (!isSelf) {
    buttons.push(
      `<button type="button" data-action="role" data-id="${user.id}" data-role="${user.role === "admin" ? "user" : "admin"}">`
      + `${user.role === "admin" ? "Gør til bruger" : "Gør til admin"}</button>`,
      `<button type="button" data-action="disabled" data-id="${user.id}" data-disabled="${!user.disabled}">`
      + `${user.disabled ? "Aktivér" : "Deaktivér"}</button>`,
      `<button type="button" class="danger" data-action="delete" data-id="${user.id}">Slet</button>`
    );
  }
  return buttons.join(" ");
}

function renderUsers(users) {
  usersStatus.hidden = true;
  usersBody.innerHTML = users.map((user) => `
    <tr>
      <td>
        <strong>${escapeHTML(user.username)}</strong>
        ${user.id === me?.id ? '<span class="tag">dig</span>' : ""}
        ${user.mustChangePassword ? '<span class="tag warn">skal skifte kode</span>' : ""}
      </td>
      <td>${user.role === "admin" ? "Administrator" : "Bruger"}</td>
      <td>${user.disabled ? '<span class="tag warn">Deaktiveret</span>' : "Aktiv"}</td>
      <td>${formatDate(user.createdAt)}</td>
      <td>${formatDate(user.lastLoginAt)}</td>
      <td class="admin-actions">${actionsFor(user)}</td>
    </tr>
  `).join("");
}

async function refresh() {
  try {
    const { users } = await api("/api/admin/users");
    renderUsers(users);
  } catch (error) {
    usersStatus.hidden = false;
    usersStatus.textContent = `Kunne ikke hente brugere: ${error.message}`;
  }
}

document.querySelector("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(createError, "");
  const button = document.querySelector("#create-submit");
  button.disabled = true;

  try {
    const result = await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        username: document.querySelector("#new-username").value,
        role: document.querySelector("#new-role").value
      })
    });
    showCredentials(result.user.username, result.password);
    document.querySelector("#new-username").value = "";
    await refresh();
  } catch (error) {
    showError(createError, error.message);
  } finally {
    button.disabled = false;
  }
});

usersBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;

  const confirmations = {
    delete: "Slet brugeren og alle deres data permanent?",
    revoke: "Log brugeren ud af alle enheder?",
    reset: "Nulstil adgangskoden? Brugeren logges ud overalt."
  };
  if (confirmations[action] && !window.confirm(confirmations[action])) return;

  button.disabled = true;
  try {
    if (action === "reset") {
      const result = await api(`/api/admin/users/${id}/reset-password`, { method: "POST" });
      const username = button.closest("tr").querySelector("strong").textContent;
      showCredentials(username, result.password);
    } else if (action === "revoke") {
      await api(`/api/admin/users/${id}/revoke`, { method: "POST" });
      showToast("Brugeren er logget ud af alle enheder");
    } else if (action === "role") {
      await api(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: button.dataset.role })
      });
    } else if (action === "disabled") {
      await api(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: button.dataset.disabled === "true" })
      });
    } else if (action === "delete") {
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
      showToast("Brugeren er slettet");
    }
    await refresh();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

credentialBox.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    showToast("Adgangskoden er kopieret");
  } catch {
    showToast("Kunne ikke kopiere — markér den i stedet");
  }
});

document.querySelector("#logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" } });
  window.location.replace("/login");
});

(async () => {
  try {
    me = (await api("/api/me")).user;
  } catch {
    return;
  }
  await refresh();
})();
