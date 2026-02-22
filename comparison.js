// Shared business logic for machine rollout sales comparisons
// Used by both Telegram bot and Google Chat bot

// ---- Kuwait timezone helpers ----

function toKuwaitDate(date) {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Kuwait" });
}

function toKuwaitTime(date) {
  // Returns HH:MM in Kuwait timezone
  return new Date(date).toLocaleTimeString("en-GB", { timeZone: "Asia/Kuwait", hour: "2-digit", minute: "2-digit", hour12: false });
}

function toKuwaitDateTime(date) {
  // Returns full Kuwait datetime string for comparison (YYYY-MM-DD HH:MM)
  const d = new Date(date);
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kuwait" });
  const timeStr = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kuwait", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${dateStr}T${timeStr}`;
}

function nowKuwait() {
  const kuwaitStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kuwait" });
  return new Date(kuwaitStr);
}

// ---- Date helpers ----

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function getDayName(dateStr) {
  return DAY_NAMES[new Date(dateStr).getDay()];
}

function getMonday(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}

function calcImpact(before, after) {
  const value = before !== 0 ? (((after - before) / before) * 100) : 0;
  return { value, sign: value >= 0 ? "+" : "" };
}

// ---- Fetch machine list ----

async function getMachineList(supabase) {
  const { data, error } = await supabase
    .from("machine_rollout")
    .select("id, machineid, installed_at, vending_machines(location, machine_id)");

  if (error || !data || data.length === 0) return null;
  return data;
}

// ---- Core comparison logic ----

async function buildComparison(supabase, rolloutId, mode) {
  const { data: rollout, error: rolloutErr } = await supabase
    .from("machine_rollout")
    .select("id, machineid, installed_at, version_name, vending_machines(location, machine_id)")
    .eq("id", rolloutId)
    .single();

  if (rolloutErr || !rollout) return { error: "Rollout data not found." };

  const machineName = rollout.vending_machines?.location || rollout.vending_machines?.machine_id || `Machine ${rollout.machineid}`;
  const vendingMachineId = rollout.machineid;
  const today = nowKuwait();
  const todayStr = toKuwaitDate(today);

  let currentStart, currentEnd, previousStart, previousEnd, periodLabel;
  const installedDateStr = toKuwaitDate(rollout.installed_at);
  const installedTimeStr = toKuwaitTime(rollout.installed_at); // HH:MM

  if (mode === "daily") {
    currentStart = installedDateStr;
    currentEnd = todayStr;
    previousStart = addDays(installedDateStr, -7);
    previousEnd = addDays(todayStr, -7);
    const daysSince = Math.floor((new Date(todayStr) - new Date(installedDateStr)) / (1000 * 60 * 60 * 24));
    periodLabel = `Install (${installedDateStr} ${installedTimeStr}) to Today (${todayStr}) — ${daysSince + 1} days, each vs prior week`;
  } else if (mode === "weekly") {
    const thisMonday = getMonday(todayStr);
    const lastMonday = addDays(thisMonday, -7);
    const lastSunday = addDays(thisMonday, -1);
    currentStart = thisMonday;
    currentEnd = todayStr;
    previousStart = lastMonday;
    previousEnd = lastSunday;
    periodLabel = `This Week (${thisMonday} to ${todayStr}) vs Last Week (${lastMonday} to ${lastSunday})`;
  } else {
    const todayDate = new Date(todayStr);
    const thisMonth1st = `${todayStr.slice(0, 7)}-01`;
    const prevMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1);
    const prevMonth1st = prevMonth.toISOString().split("T")[0];
    const lastDayPrevMonth = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0).getDate();
    const prevDay = Math.min(todayDate.getDate(), lastDayPrevMonth);
    const prevMonthEnd = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, prevDay).toISOString().split("T")[0];
    currentStart = thisMonth1st;
    currentEnd = todayStr;
    previousStart = prevMonth1st;
    previousEnd = prevMonthEnd;
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    periodLabel = `${monthNames[todayDate.getMonth()]} (${thisMonth1st} to ${todayStr}) vs ${monthNames[prevMonth.getMonth()]} (${prevMonth1st} to ${prevMonthEnd})`;
  }

  // Fetch sales for both periods
  const { data: sales, error: salesErr } = await supabase
    .from("sales")
    .select("sold_at, quantity, unit_price")
    .eq("vending_machine_id", vendingMachineId)
    .gte("sold_at", previousStart + "T00:00:00+03:00")
    .lte("sold_at", currentEnd + "T23:59:59+03:00")
    .order("sold_at", { ascending: true });

  if (salesErr || !sales || sales.length === 0) return { error: "No sales data found for the selected period." };

  // Dates that need time-based filtering (install day + its comparison day)
  const installCompareDate = addDays(installedDateStr, -7);
  const timeCutoffDates = new Set([installedDateStr, installCompareDate]);

  // Aggregate sales by Kuwait date, filtering by install time on relevant days
  const dailyMap = {};
  for (const s of sales) {
    const dateKey = toKuwaitDate(s.sold_at);

    // On the install date and its comparison date, only count sales from install time onward
    if (timeCutoffDates.has(dateKey)) {
      const saleTime = toKuwaitTime(s.sold_at);
      if (saleTime < installedTimeStr) continue;
    }

    if (!dailyMap[dateKey]) dailyMap[dateKey] = { date: dateKey, total_sales: 0, total_qty: 0 };
    dailyMap[dateKey].total_sales += s.quantity * Number(s.unit_price);
    dailyMap[dateKey].total_qty += s.quantity;
  }

  // Split into current and previous periods
  const currentSales = [];
  const previousSales = [];
  for (const day of Object.values(dailyMap)) {
    if (day.date >= currentStart && day.date <= currentEnd) currentSales.push(day);
    if (day.date >= previousStart && day.date <= previousEnd) previousSales.push(day);
  }
  currentSales.sort((a, b) => a.date.localeCompare(b.date));
  previousSales.sort((a, b) => a.date.localeCompare(b.date));

  const info = {
    machineName,
    version: rollout.version_name,
    installedDate: toKuwaitDate(rollout.installed_at),
    installedTime: installedTimeStr,
  };

  // Return structured data instead of formatted strings
  return {
    mode,
    info,
    periodLabel,
    dailyMap,
    installedDateStr,
    todayStr,
    currentSales,
    previousSales,
  };
}

// ---- Telegram HTML formatters ----

function formatDailyTelegram(result) {
  const { info, periodLabel, dailyMap, installedDateStr, todayStr } = result;

  let msg = `<b>📊 Daily Sales Comparison</b>\n`;
  msg += `<b>Machine:</b> ${info.machineName}\n`;
  msg += `<b>Version:</b> ${info.version || "N/A"}\n`;
  msg += `<b>Installed:</b> ${info.installedDate} ${info.installedTime}\n`;
  msg += `<b>Period:</b> ${periodLabel}\n\n`;

  msg += `<pre>`;
  msg += `Date       | Day | This Wk  | Last Wk  | Change\n`;
  msg += `-----------+-----+----------+----------+--------\n`;

  let totalCurrent = 0, totalPrevious = 0;
  let date = installedDateStr;

  while (date <= todayStr) {
    const lastWeekDate = addDays(date, -7);
    const cur = dailyMap[date];
    const prev = dailyMap[lastWeekDate];
    const curSales = cur ? cur.total_sales : 0;
    const prevSales = prev ? prev.total_sales : 0;
    const dayImpact = prevSales !== 0 ? (((curSales - prevSales) / prevSales) * 100) : 0;
    const sign = dayImpact >= 0 ? "+" : "";
    const dayShort = getDayName(date).slice(0, 3);

    totalCurrent += curSales;
    totalPrevious += prevSales;

    msg += `${date} | ${dayShort} | ${curSales.toFixed(3).padStart(8)} | ${prevSales.toFixed(3).padStart(8)} | ${sign}${dayImpact.toFixed(1)}%\n`;
    date = addDays(date, 1);
  }
  msg += `</pre>\n`;

  const overallImpact = calcImpact(totalPrevious, totalCurrent);
  msg += `<b>Total (This Period):</b> ${totalCurrent.toFixed(3)} KWD\n`;
  msg += `<b>Total (Last Week equiv):</b> ${totalPrevious.toFixed(3)} KWD\n`;
  msg += `<b>Overall Change: ${overallImpact.sign}${overallImpact.value.toFixed(2)}%</b>\n`;
  msg += overallImpact.value >= 0 ? "📈 Sales are up!" : "📉 Sales are down.";

  return msg;
}

function formatWeeklyTelegram(result) {
  const { info, periodLabel, currentSales, previousSales } = result;

  const curTotal = currentSales.reduce((a, b) => a + b.total_sales, 0);
  const curQty = currentSales.reduce((a, b) => a + b.total_qty, 0);
  const prevTotal = previousSales.reduce((a, b) => a + b.total_sales, 0);
  const prevQty = previousSales.reduce((a, b) => a + b.total_qty, 0);
  const impact = calcImpact(prevTotal, curTotal);

  const prevMap = {};
  for (const s of previousSales) prevMap[getDayName(s.date)] = s;
  const curMap = {};
  for (const s of currentSales) curMap[getDayName(s.date)] = s;

  let msg = `<b>📊 Weekly Sales Comparison</b>\n`;
  msg += `<b>Machine:</b> ${info.machineName}\n`;
  msg += `<b>Version:</b> ${info.version || "N/A"}\n`;
  msg += `<b>Period:</b> ${periodLabel}\n\n`;

  msg += `<pre>`;
  msg += `Day       | Last Wk  | This Wk  | Change\n`;
  msg += `----------+----------+----------+--------\n`;

  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
    const p = prevMap[day];
    const c = curMap[day];
    const pSales = p ? p.total_sales : 0;
    const cSales = c ? c.total_sales : 0;
    const dayImpact = pSales !== 0 ? (((cSales - pSales) / pSales) * 100) : 0;
    const sign = dayImpact >= 0 ? "+" : "";
    const short = day.slice(0, 3);
    msg += `${short.padEnd(9)} | ${pSales.toFixed(3).padStart(8)} | ${cSales.toFixed(3).padStart(8)} | ${sign}${dayImpact.toFixed(1)}%\n`;
  }
  msg += `</pre>\n`;

  msg += `<b>Last Week Total:</b> ${prevTotal.toFixed(3)} KWD (${prevQty} items)\n`;
  msg += `<b>This Week Total:</b> ${curTotal.toFixed(3)} KWD (${curQty} items)\n`;
  msg += `<b>Change: ${impact.sign}${impact.value.toFixed(2)}%</b>\n`;
  msg += impact.value >= 0 ? "📈 Sales are up!" : "📉 Sales are down.";

  return msg;
}

function formatMonthlyTelegram(result) {
  const { info, periodLabel, currentSales, previousSales } = result;

  const curTotal = currentSales.reduce((a, b) => a + b.total_sales, 0);
  const curQty = currentSales.reduce((a, b) => a + b.total_qty, 0);
  const prevTotal = previousSales.reduce((a, b) => a + b.total_sales, 0);
  const prevQty = previousSales.reduce((a, b) => a + b.total_qty, 0);
  const curAvg = currentSales.length > 0 ? curTotal / currentSales.length : 0;
  const prevAvg = previousSales.length > 0 ? prevTotal / previousSales.length : 0;
  const impact = calcImpact(prevTotal, curTotal);
  const avgImpact = calcImpact(prevAvg, curAvg);

  let msg = `<b>📊 Monthly Sales Comparison</b>\n`;
  msg += `<b>Machine:</b> ${info.machineName}\n`;
  msg += `<b>Version:</b> ${info.version || "N/A"}\n`;
  msg += `<b>Period:</b> ${periodLabel}\n\n`;

  msg += `<b>Previous Month:</b>\n`;
  msg += `  Total: ${prevTotal.toFixed(3)} KWD\n`;
  msg += `  Qty: ${prevQty}\n`;
  msg += `  Days: ${previousSales.length}\n`;
  msg += `  Avg/day: ${prevAvg.toFixed(3)} KWD\n\n`;

  msg += `<b>This Month:</b>\n`;
  msg += `  Total: ${curTotal.toFixed(3)} KWD\n`;
  msg += `  Qty: ${curQty}\n`;
  msg += `  Days: ${currentSales.length}\n`;
  msg += `  Avg/day: ${curAvg.toFixed(3)} KWD\n\n`;

  msg += `<b>Total Change: ${impact.sign}${impact.value.toFixed(2)}%</b>\n`;
  msg += `<b>Avg/day Change: ${avgImpact.sign}${avgImpact.value.toFixed(2)}%</b>\n`;
  msg += impact.value >= 0 ? "📈 Sales are up!" : "📉 Sales are down.";

  return msg;
}

// ---- Google Chat plain-text formatters ----

function formatDailyGChat(result) {
  const { info, periodLabel, dailyMap, installedDateStr, todayStr } = result;

  let msg = `*Daily Sales Comparison*\n`;
  msg += `*Machine:* ${info.machineName}\n`;
  msg += `*Version:* ${info.version || "N/A"}\n`;
  msg += `*Installed:* ${info.installedDate} ${info.installedTime}\n`;
  msg += `*Period:* ${periodLabel}\n\n`;

  msg += "```\n";
  msg += `Date       | Day | This Wk  | Last Wk  | Change\n`;
  msg += `-----------+-----+----------+----------+--------\n`;

  let totalCurrent = 0, totalPrevious = 0;
  let date = installedDateStr;

  while (date <= todayStr) {
    const lastWeekDate = addDays(date, -7);
    const cur = dailyMap[date];
    const prev = dailyMap[lastWeekDate];
    const curSales = cur ? cur.total_sales : 0;
    const prevSales = prev ? prev.total_sales : 0;
    const dayImpact = prevSales !== 0 ? (((curSales - prevSales) / prevSales) * 100) : 0;
    const sign = dayImpact >= 0 ? "+" : "";
    const dayShort = getDayName(date).slice(0, 3);

    totalCurrent += curSales;
    totalPrevious += prevSales;

    msg += `${date} | ${dayShort} | ${curSales.toFixed(3).padStart(8)} | ${prevSales.toFixed(3).padStart(8)} | ${sign}${dayImpact.toFixed(1)}%\n`;
    date = addDays(date, 1);
  }
  msg += "```\n\n";

  const overallImpact = calcImpact(totalPrevious, totalCurrent);
  msg += `*Total (This Period):* ${totalCurrent.toFixed(3)} KWD\n`;
  msg += `*Total (Last Week equiv):* ${totalPrevious.toFixed(3)} KWD\n`;
  msg += `*Overall Change: ${overallImpact.sign}${overallImpact.value.toFixed(2)}%*\n`;

  return msg;
}

function formatWeeklyGChat(result) {
  const { info, periodLabel, currentSales, previousSales } = result;

  const curTotal = currentSales.reduce((a, b) => a + b.total_sales, 0);
  const curQty = currentSales.reduce((a, b) => a + b.total_qty, 0);
  const prevTotal = previousSales.reduce((a, b) => a + b.total_sales, 0);
  const prevQty = previousSales.reduce((a, b) => a + b.total_qty, 0);
  const impact = calcImpact(prevTotal, curTotal);

  const prevMap = {};
  for (const s of previousSales) prevMap[getDayName(s.date)] = s;
  const curMap = {};
  for (const s of currentSales) curMap[getDayName(s.date)] = s;

  let msg = `*Weekly Sales Comparison*\n`;
  msg += `*Machine:* ${info.machineName}\n`;
  msg += `*Version:* ${info.version || "N/A"}\n`;
  msg += `*Period:* ${periodLabel}\n\n`;

  msg += "```\n";
  msg += `Day       | Last Wk  | This Wk  | Change\n`;
  msg += `----------+----------+----------+--------\n`;

  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
    const p = prevMap[day];
    const c = curMap[day];
    const pSales = p ? p.total_sales : 0;
    const cSales = c ? c.total_sales : 0;
    const dayImpact = pSales !== 0 ? (((cSales - pSales) / pSales) * 100) : 0;
    const sign = dayImpact >= 0 ? "+" : "";
    const short = day.slice(0, 3);
    msg += `${short.padEnd(9)} | ${pSales.toFixed(3).padStart(8)} | ${cSales.toFixed(3).padStart(8)} | ${sign}${dayImpact.toFixed(1)}%\n`;
  }
  msg += "```\n\n";

  msg += `*Last Week Total:* ${prevTotal.toFixed(3)} KWD (${prevQty} items)\n`;
  msg += `*This Week Total:* ${curTotal.toFixed(3)} KWD (${curQty} items)\n`;
  msg += `*Change: ${impact.sign}${impact.value.toFixed(2)}%*\n`;

  return msg;
}

function formatMonthlyGChat(result) {
  const { info, periodLabel, currentSales, previousSales } = result;

  const curTotal = currentSales.reduce((a, b) => a + b.total_sales, 0);
  const curQty = currentSales.reduce((a, b) => a + b.total_qty, 0);
  const prevTotal = previousSales.reduce((a, b) => a + b.total_sales, 0);
  const prevQty = previousSales.reduce((a, b) => a + b.total_qty, 0);
  const curAvg = currentSales.length > 0 ? curTotal / currentSales.length : 0;
  const prevAvg = previousSales.length > 0 ? prevTotal / previousSales.length : 0;
  const impact = calcImpact(prevTotal, curTotal);
  const avgImpact = calcImpact(prevAvg, curAvg);

  let msg = `*Monthly Sales Comparison*\n`;
  msg += `*Machine:* ${info.machineName}\n`;
  msg += `*Version:* ${info.version || "N/A"}\n`;
  msg += `*Period:* ${periodLabel}\n\n`;

  msg += `*Previous Month:*\n`;
  msg += `  Total: ${prevTotal.toFixed(3)} KWD\n`;
  msg += `  Qty: ${prevQty}\n`;
  msg += `  Days: ${previousSales.length}\n`;
  msg += `  Avg/day: ${prevAvg.toFixed(3)} KWD\n\n`;

  msg += `*This Month:*\n`;
  msg += `  Total: ${curTotal.toFixed(3)} KWD\n`;
  msg += `  Qty: ${curQty}\n`;
  msg += `  Days: ${currentSales.length}\n`;
  msg += `  Avg/day: ${curAvg.toFixed(3)} KWD\n\n`;

  msg += `*Total Change: ${impact.sign}${impact.value.toFixed(2)}%*\n`;
  msg += `*Avg/day Change: ${avgImpact.sign}${avgImpact.value.toFixed(2)}%*\n`;

  return msg;
}

// ---- Format dispatcher ----

function formatTelegram(result) {
  if (result.error) return result.error;
  if (result.mode === "daily") return formatDailyTelegram(result);
  if (result.mode === "weekly") return formatWeeklyTelegram(result);
  return formatMonthlyTelegram(result);
}

function formatGChat(result) {
  if (result.error) return result.error;
  if (result.mode === "daily") return formatDailyGChat(result);
  if (result.mode === "weekly") return formatWeeklyGChat(result);
  return formatMonthlyGChat(result);
}

module.exports = {
  getMachineList,
  buildComparison,
  formatTelegram,
  formatGChat,
};
