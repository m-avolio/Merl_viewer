import { startViewer } from "./viewer.js";

startViewer().catch((error) => {
  console.error(error);
  const status = document.querySelector("#status");
  const dot = document.querySelector("#statusDot");

  if (status) {
    status.textContent = error.message || "Could not start viewer.";
    status.classList.remove("is-hidden");
  }

  if (dot) {
    dot.classList.add("is-error");
  }
});
