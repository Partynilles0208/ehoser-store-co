document.getElementById("adminAccessForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.getElementById("message");
  const code = document.getElementById("code").value;
  const response = await fetch("/api/admin/access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (response.ok) {
    window.location.href = "/admin";
    return;
  }
  const data = await response.json().catch(() => ({}));
  message.textContent = data.error || "Admin-Zugang nicht moeglich.";
});
