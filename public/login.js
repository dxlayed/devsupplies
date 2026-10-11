const form = $("form");
let mode = "login";

function setMode(next) {
  mode = next;
  const signup = mode === "signup";
  $("tabLogin").setAttribute("aria-selected", !signup);
  $("tabSignup").setAttribute("aria-selected", signup);
  $("title").textContent = signup ? "Create your account" : "Welcome back";
  $("subtitle").textContent = signup
    ? "Pick a username (3–20 letters, numbers or _) and a password of 8+ characters."
    : "Log in with your username to check out.";
  $("submit").textContent = signup ? "Create account" : "Log in";
  form.password.autocomplete = signup ? "new-password" : "current-password";
  $("confirmField").hidden = !signup;
  form.confirm.value = "";
  $("codeField").hidden = true;
  form.code.value = "";
  showError("error");
}

$("tabLogin").addEventListener("click", () => setMode("login"));
$("tabSignup").addEventListener("click", () => setMode("signup"));

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("error");
  const username = form.username.value.trim();
  if (!username || !form.password.value) return showError("error", "Enter your username and password");
  if (mode === "signup") {
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return showError("error", "Username must be 3–20 letters, numbers or _");
    if (form.password.value.length < 8) return showError("error", "Password must be at least 8 characters");
    if (form.password.value !== form.confirm.value) { form.confirm.focus(); return showError("error", "Passwords don't match"); }
  }
  $("submit").disabled = true;
  try {
    await api("POST", mode === "signup" ? "/api/register" : "/api/user/login", {
      username,
      password: form.password.value,
      confirm: form.confirm.value,
      code: form.code.value,
    });
    const me = await api("GET", "/api/me").catch(() => ({}));
    location.href = me.owner ? "/owner" : "/account";
  } catch (err) {
    // Creating the owner account asks for the one-time setup code.
    if (err.data && err.data.needsCode) { $("codeField").hidden = false; form.code.focus(); }
    showError("error", err.message);
    $("submit").disabled = false;
  }
});

if (location.hash === "#signup") setMode("signup");

// Already logged in? Go to the account page.
api("GET", "/api/me").then((me) => { if (me.user) location.href = me.owner ? "/owner" : "/account"; }).catch(() => {});
