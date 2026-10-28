import { aiFeatureOn, useAiSettings, type AiFeatureKey } from "../../data/aiSettings.ts";

export type AiFeature = "employee360" | "cv" | "jobDescription";

const KEY: Record<AiFeature, AiFeatureKey> = {
  employee360: "employee360",
  cv: "cvReading",
  jobDescription: "jdWriter",
};

/** Whether a draft helper is switched on in AI settings. */
export function aiOn(key: AiFeature): boolean {
  return aiFeatureOn(KEY[key]);
}

/** Same as aiOn, and re-renders when an admin changes the setting. */
export function useAiOn(key: AiFeature): boolean {
  return !useAiSettings().disabledFeatures.includes(KEY[key]);
}
