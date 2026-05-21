/**
 * Shared presets. Each consuming site composes an `EngineConfig` from its own
 * business constants plus one of the category presets below — the category set
 * is the single intended difference between the PRO MAX and PULSE sites.
 */
import type { CategoryDef, GeoLocation } from "./types.js";

/** Downtown Sacramento — both sites serve the same metro. */
export const SACRAMENTO_LOCATION: GeoLocation = {
  latitude: 38.5816,
  longitude: -121.4944,
  timezone: "America/Los_Angeles",
};

/**
 * HVAC-only category set (PULSE). Four sub-buckets give the rotation logic
 * enough variety to spread topics across the heating/cooling/air/efficiency
 * space without ever leaving HVAC.
 */
export const HVAC_CATEGORIES: CategoryDef[] = [
  {
    id: "cooling",
    label: "Cooling",
    keywords: [
      "ac",
      "a/c",
      "air conditioner",
      "air conditioning",
      "condenser",
      "evaporative cooler",
      "swamp cooler",
      "whole-house fan",
      "whole house fan",
      "mini-split",
      "mini split",
      "seer",
      "compressor",
    ],
    guidance:
      "Air conditioning and whole-home cooling — performance, repairs, efficiency, and comfort in the heat.",
  },
  {
    id: "heating",
    label: "Heating",
    keywords: [
      "furnace",
      "heat pump",
      "heating",
      "heater",
      "gas furnace",
      "backup heat",
      "pilot light",
      "no heat",
    ],
    guidance:
      "Furnaces, heat pumps, and home heating — reliability, warning signs, and winter comfort.",
  },
  {
    id: "air-quality",
    label: "Air Quality & Ducts",
    keywords: [
      "duct",
      "ductwork",
      "iaq",
      "indoor air quality",
      "air quality",
      "filter",
      "merv",
      "hepa",
      "ventilation",
      "smoke",
    ],
    guidance:
      "Indoor air quality, filtration, ductwork, and ventilation — cleaner, healthier air at home.",
  },
  {
    id: "efficiency-controls",
    label: "Efficiency & Controls",
    keywords: [
      "thermostat",
      "smart thermostat",
      "rebate",
      "smud",
      "time-of-use",
      "tou",
      "energy efficiency",
      "tune-up",
      "maintenance",
      "insulation",
    ],
    guidance:
      "Thermostats, smart controls, efficiency upgrades, rebates, and maintenance that lowers energy bills.",
  },
];

/**
 * HVAC + appliance + rebate category set (PRO MAX). Order matters: `rebate` is
 * checked first because rebate posts often also mention HVAC keywords.
 */
export const HVAC_APPLIANCE_CATEGORIES: CategoryDef[] = [
  {
    id: "rebate",
    label: "Rebates & Incentives",
    keywords: [
      "smud",
      "pcwa",
      "pg&e",
      "rebate",
      "incentive",
      "tech clean california",
      "25c",
      "tax credit",
      "time-of-day",
      "time-of-use",
      "tou",
      "ira",
      "inflation reduction act",
    ],
    guidance:
      "Local and federal rebates, incentives, and utility programs that offset HVAC or appliance upgrades.",
  },
  {
    id: "appliance",
    label: "Appliance Repair",
    keywords: [
      "refrigerator",
      "fridge",
      "freezer",
      "ice maker",
      "dishwasher",
      "washer",
      "washing machine",
      "dryer",
      "oven",
      "range",
      "cooktop",
      "stove",
      "microwave",
      "garbage disposal",
      "appliance",
    ],
    guidance:
      "Residential appliance repair and maintenance — refrigerators, dishwashers, washers, dryers, ovens, and ranges.",
  },
  {
    id: "hvac",
    label: "HVAC",
    keywords: [
      "hvac",
      "ac",
      "a/c",
      "air conditioner",
      "air conditioning",
      "furnace",
      "heat pump",
      "duct",
      "ductwork",
      "thermostat",
      "iaq",
      "indoor air quality",
      "air quality",
      "mini-split",
      "mini split",
      "whole-house fan",
      "whole house fan",
      "evaporative cooler",
      "swamp cooler",
      "filter",
      "merv",
      "hepa",
    ],
    guidance: "Heating, cooling, ductwork, and indoor air quality for the home.",
  },
];
