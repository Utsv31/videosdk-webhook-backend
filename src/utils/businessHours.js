const IST_OFFSET_MS = 330 * 60 * 1000;
const DEFAULT_START_HOUR_IST = 9;
const DEFAULT_END_HOUR_IST = 21;

function getBusinessHoursConfig() {
  return {
    startHour: Number.parseInt(process.env.CALL_WINDOW_START_HOUR_IST, 10) || DEFAULT_START_HOUR_IST,
    endHour: Number.parseInt(process.env.CALL_WINDOW_END_HOUR_IST, 10) || DEFAULT_END_HOUR_IST,
  };
}

function getIstParts(date) {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);

  return {
    year: istDate.getUTCFullYear(),
    month: istDate.getUTCMonth(),
    day: istDate.getUTCDate(),
    hour: istDate.getUTCHours(),
    minute: istDate.getUTCMinutes(),
    second: istDate.getUTCSeconds(),
    millisecond: istDate.getUTCMilliseconds(),
  };
}

function buildUtcDateFromIstParts({ year, month, day, hour, minute = 0, second = 0, millisecond = 0 }) {
  return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond) - IST_OFFSET_MS);
}

function isWithinCallWindow(date = new Date()) {
  const { startHour, endHour } = getBusinessHoursConfig();
  const parts = getIstParts(date);
  const currentMinutes = parts.hour * 60 + parts.minute;

  return currentMinutes >= startHour * 60 && currentMinutes < endHour * 60;
}

function getNextCallWindowStart(date = new Date()) {
  const { startHour, endHour } = getBusinessHoursConfig();
  const parts = getIstParts(date);
  const currentMinutes = parts.hour * 60 + parts.minute;

  if (currentMinutes < startHour * 60) {
    return buildUtcDateFromIstParts({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: startHour,
    });
  }

  if (currentMinutes >= endHour * 60) {
    return buildUtcDateFromIstParts({
      year: parts.year,
      month: parts.month,
      day: parts.day + 1,
      hour: startHour,
    });
  }

  return date;
}

function formatIst(date) {
  const parts = getIstParts(date);
  const pad = (value, size = 2) => String(value).padStart(size, '0');

  return `${parts.year}-${pad(parts.month + 1)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)} IST`;
}

function applyCallWindow(date = new Date()) {
  const adjustedDate = getNextCallWindowStart(date);

  return {
    requestedAt: date,
    scheduledAt: adjustedDate,
    adjusted: adjustedDate.getTime() !== date.getTime(),
    requestedAtIst: formatIst(date),
    scheduledAtIst: formatIst(adjustedDate),
  };
}

module.exports = {
  DEFAULT_START_HOUR_IST,
  DEFAULT_END_HOUR_IST,
  applyCallWindow,
  formatIst,
  getBusinessHoursConfig,
  getNextCallWindowStart,
  isWithinCallWindow,
};
