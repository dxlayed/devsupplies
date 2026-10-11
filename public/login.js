const $ = (id) => document.getElementById(id);
const form = $("form");
let mode = "login";
const NO_SERVER = "Can't reach the server. Start the site with \"node server.js\" and open http://localhost:4173 (Live Server and static hosts can't create accounts).";

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
    }).catch(() => { throw new Error(NO_SERVER); });
    // Anything other than JSON means the page isn't being served by server.js.
    if (!/application\/json/.test(res.headers.get("content-type") || "")) throw new Error(NO_SERVER);
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

// Messages sent back from Google sign-in.
const GOOGLE_ERRORS = {
  "google": "Google sign-in didn't work. Please try again.",
  "google-off": "Google sign-in isn't set up yet. Add your Google keys to data/google.json (see README.txt).",
  "google-unverified": "That Google account's email isn't verified.",
};
const errorKey = new URLSearchParams(location.search).get("error");
if (GOOGLE_ERRORS[errorKey]) {
  $("error").textContent = GOOGLE_ERRORS[errorKey];
  $("error").hidden = false;
  history.replaceState(null, "", location.pathname + location.hash);
}

// Already logged in? Skip the form.
fetch("/api/me").then((r) => r.json()).then((me) => { if (me.user) location.href = "/"; }).catch(() => {});
