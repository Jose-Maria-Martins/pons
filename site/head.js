// Runs before the page paints, so neither the saved theme nor a repeat visit ever flashes.

// The light/dark switch's saved choice. Without one, the page follows the system setting.
try {
  const theme = localStorage.getItem("pons-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // Storage blocked: follow the system setting.
}

// Play the opening animation once per visit.
try {
  if (sessionStorage.getItem("pons-splash")) document.documentElement.classList.add("seen");
  else sessionStorage.setItem("pons-splash", "1");
} catch {
  // Storage blocked: the animation plays every time, which is harmless.
}

// The light/dark switch in the header, on this page and the privacy page. It flips whatever the page shows now and remembers the choice.
addEventListener("DOMContentLoaded", () => {
  const switcher = document.querySelector(".theme");
  const system = matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => (document.documentElement.dataset.theme || (system.matches ? "dark" : "light")) === "dark";
  const show = () => switcher.setAttribute("aria-pressed", isDark());
  switcher.addEventListener("click", () => {
    const theme = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("pons-theme", theme);
    } catch {
      // Storage blocked: the choice lasts until the page closes.
    }
    show();
  });
  show();
  system.addEventListener("change", show);
});
