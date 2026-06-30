// Minimal interactions for the example app. The "Simulate error" button exists
// to exercise the widget's diagnostics capture (a console error + a failed
// network request that show up alongside any feedback left afterwards).

const refresh = document.getElementById("refresh");
if (refresh) {
  refresh.addEventListener("click", () => {
    refresh.textContent = "Refreshing…";
    setTimeout(() => {
      refresh.textContent = "Refresh data";
    }, 600);
  });
}

const breakBtn = document.getElementById("break");
if (breakBtn) {
  breakBtn.addEventListener("click", () => {
    console.error("Failed to load activity feed: timeout after 5000ms");
    fetch("/api/activity").catch(() => {});
  });
}

const profile = document.getElementById("profile");
if (profile) {
  profile.addEventListener("submit", (e) => {
    e.preventDefault();
    console.log("Profile saved (pretend)");
  });
}
