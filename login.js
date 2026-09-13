const loginForm = document.querySelector("#login-form");
const changeForm = document.querySelector("#change-form");
const loginError = document.querySelector("#login-error");
const changeError = document.querySelector("#change-error");

function showError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function showChangeForm() {
  loginForm.hidden = true;
  changeForm.hidden = false;
  document.querySelector("#current-password").focus();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  return { response, payload };
}

function busy(button, isBusy, label) {
  button.disabled = isBusy;
  button.textContent = isBusy ? "Vent…" : label;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(loginError, "");
  const button = document.querySelector("#login-submit");
  busy(button, true, "Log ind");

  try {
    const { response, payload } = await postJson("/api/login", {
      username: document.querySelector("#username").value,
      password: document.querySelector("#password").value
    });

    if (!response.ok) {
      showError(loginError, payload.error || "Kunne ikke logge ind");
      return;
    }
    if (payload.mustChangePassword) {
      // Carry the password over so the change form does not ask for it twice.
      document.querySelector("#current-password").value = document.querySelector("#password").value;
      showChangeForm();
      return;
    }
    window.location.replace("/");
  } catch {
    showError(loginError, "Ingen forbindelse til serveren");
  } finally {
    busy(button, false, "Log ind");
  }
});

changeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(changeError, "");

  const newPassword = document.querySelector("#new-password").value;
  if (newPassword !== document.querySelector("#repeat-password").value) {
    showError(changeError, "De to adgangskoder er ikke ens");
    return;
  }

  const button = document.querySelector("#change-submit");
  busy(button, true, "Gem og fortsæt");
  try {
    const { response, payload } = await postJson("/api/password", {
      currentPassword: document.querySelector("#current-password").value,
      newPassword
    });
    if (!response.ok) {
      showError(changeError, payload.error || "Kunne ikke skifte adgangskode");
      return;
    }
    window.location.replace("/");
  } catch {
    showError(changeError, "Ingen forbindelse til serveren");
  } finally {
    busy(button, false, "Gem og fortsæt");
  }
});

// Arriving at /login?change=1 means a session exists but the password is stale.
if (new URLSearchParams(window.location.search).get("change") === "1") {
  showChangeForm();
}
