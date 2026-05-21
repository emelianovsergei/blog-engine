/** Season detection and a domain-agnostic Sacramento climate description. */

export type Season = "Winter" | "Spring" | "Summer" | "Fall";

export interface SeasonContext {
  season: Season;
  monthName: string;
  /** Generic Sacramento climate description for this time of year. */
  climate: string;
}

const CLIMATE: Record<Season, string> = {
  Summer:
    "Hot, dry Sacramento summer — daytime highs frequently 95-105°F, recurring " +
    "triple-digit heat waves, and wildfire smoke from regional fires that degrades " +
    "outdoor air quality.",
  Fall:
    "Cooling Sacramento autumn — warm afternoons giving way to chilly mornings, the " +
    "first heating-system use of the season, and the start of holiday cooking and " +
    "entertaining.",
  Winter:
    "Cool, damp Sacramento winter — overnight lows near freezing, persistent tule " +
    "fog, and steady rain. Heating systems run daily.",
  Spring:
    "Mild Sacramento spring — swinging between cool and warm, with the first hot " +
    "days arriving by May. The planning window before peak summer cooling demand.",
};

/** Maps a 1-12 month number to a season. */
export function seasonForMonth(month: number): Season {
  if (month >= 6 && month <= 9) return "Summer";
  if (month >= 10 && month <= 11) return "Fall";
  if (month === 12 || month <= 2) return "Winter";
  return "Spring";
}

function monthInTimezone(now: Date, timezone: string): { month: number; monthName: string } {
  const monthName = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "long",
  }).format(now);
  const month = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "numeric" }).format(now),
  );
  return { month, monthName };
}

export function getSeasonContext(now: Date, timezone: string): SeasonContext {
  const { month, monthName } = monthInTimezone(now, timezone);
  const season = seasonForMonth(month);
  return { season, monthName, climate: CLIMATE[season] };
}
