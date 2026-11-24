// What a member has already been shown: the first-visit tour and the three one-time hints. Kept in this browser,
// per person, so the tour comes once and each hint is said once; "Take the tour" in the account menu replays it.

import { createStore, remembered } from "../lib/store.ts";

/** The tour, and the hints shown at the moment each matters. */
export type Lesson = "tour" | "mention" | "thread" | "scribe";

type Seen = Partial<Record<Lesson, true>>;

interface Onboarding {
  userId: number | null;
  seen: Seen;
  /** The tour's step while it is showing; null when it is not. */
  step: number | null;
}

const storageKey = (userId: number) => `autoforum.onboarding.${userId}`;

export const onboarding = createStore<Onboarding>({ userId: null, seen: {}, step: null });

export function loadOnboarding(userId: number): void {
  if (onboarding.get().userId === userId) return;
  onboarding.set({ userId, seen: remembered.read<Seen>(storageKey(userId), {}), step: null });
}

export function markSeen(lesson: Lesson): void {
  onboarding.set((state) => {
    if (state.seen[lesson]) return state;
    const seen = { ...state.seen, [lesson]: true as const };
    if (state.userId !== null) remembered.write(storageKey(state.userId), seen);
    return { ...state, seen };
  });
}

export const startTour = (): void => onboarding.set((state) => ({ ...state, step: 0 }));
export const showStep = (step: number): void => onboarding.set((state) => ({ ...state, step }));

/** Finished or skipped, the tour counts as seen: it does not come back on its own. */
export function endTour(): void {
  markSeen("tour");
  onboarding.set((state) => ({ ...state, step: null }));
}
