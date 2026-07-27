const TARGET_DATE = new Date("2026-07-30T22:00:00+02:00");
const countdownStatusEl = document.getElementById("countdownStatus");
const daysEl = document.getElementById("days");
const hoursEl = document.getElementById("hours");
const minutesEl = document.getElementById("minutes");
const secondsEl = document.getElementById("seconds");

function pad(value) {
  return String(value).padStart(2, "0");
}

function updateCountdown() {
  const diff = TARGET_DATE.getTime() - Date.now();

  if (diff <= 0) {
    daysEl.textContent = "0";
    hoursEl.textContent = "00";
    minutesEl.textContent = "00";
    secondsEl.textContent = "00";
    countdownStatusEl.textContent = "Update-Zeit erreicht.";
    return false;
  }

  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  daysEl.textContent = String(days);
  hoursEl.textContent = pad(hours);
  minutesEl.textContent = pad(minutes);
  secondsEl.textContent = pad(seconds);

  return true;
}

function startCountdown() {
  const isActive = updateCountdown();
  if (!isActive) return;

  const timer = setInterval(() => {
    const stillActive = updateCountdown();
    if (!stillActive) clearInterval(timer);
  }, 1000);
}

startCountdown();
