document.getElementById("accessForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.getElementById("message");
  const code = document.getElementById("code").value.trim();
  const response = await fetch("/api/access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (response.ok) {
    window.location.href = "/store";
    return;
  }
  const data = await response.json().catch(() => ({}));
  message.textContent = data.error || "Zugang nicht moeglich.";
});
