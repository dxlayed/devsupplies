const $ = (id) => document.getElementById(id);
const form = $("form");
let mode = "login";

function setMode(next) {
  mode = next;
  const signup = mode === "signup";
  $("tabLogin").setAttribute("aria-selected", !signup);
  $("tabSignup").setAttribute("aria-selected", signup);
  $("title").textContent = signup ? "Create your account" : "Welcome back";
  $("subtitle").textContent = signup ? "Use any email address. Password needs 8+ characters." : "Log in with your email to check out.";
  $("submit").textContent = signup ? "Create account" : "Log in";
  form.password.autocomplete = signup ? "new-password" : "current-password";
  $("error").hidden = true;
  $("codeField").hidden = true;
  form.code.value = "";
}

$("tabLogin").addEventListener("click", () => setMode("login"));
$("tabSignup").addEventListener("click", () => setMode("signup"));

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("error").hidden = true;
  $("submit").disabled = true;
  try {
    const res = await fetch(mode === "signup" ? "/api/register" : "/api/user/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.email.value, password: form.password.value, code: form.code.value }),
    });
    const data = await res.json().catch(() => ({}));
    // Creating the owner's account asks for the one-time setup code.
    if (data.needsCode) $("codeField").hidden = false;
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    const me = await fetch("/api/me").then((r) => r.json()).catch(() => ({}));
    location.href = me.owner ? "/owner" : "/";
  } catch (err) {
    $("error").textContent = err.message;
    $("error").hidden = false;
    $("submit").disabled = false;
  }
});

if (location.hash === "#signup") setMode("signup");

// Already logged in? Skip the form.
fetch("/api/me").then((r) => r.json()).then((me) => { if (me.user) location.href = "/"; }).catch(() => {});
