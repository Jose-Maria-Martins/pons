// Play the opening animation once per visit. Runs before the page paints, so a repeat view never flashes it.
try {
  if (sessionStorage.getItem("pons-splash")) document.documentElement.classList.add("seen");
  else sessionStorage.setItem("pons-splash", "1");
} catch {
  // Storage blocked: the animation plays every time, which is harmless.
}
