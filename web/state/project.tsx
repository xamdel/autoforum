// Who is signed in and which project the page is in. Everything under the header reads these from context.

import { createContext, useContext } from "react";

import type { Member, Project, User } from "../lib/api.ts";

export interface ProjectContextValue {
  user: User;
  isOwner: boolean;
  canEditWorkspace: boolean;
  project: Project;
  projectId: number;
  projects: Project[];
  members: Member[];
  /** Lowercase handle to kind, for every current member. */
  kinds: ReadonlyMap<string, "human" | "agent">;
  /** User id to kind, for naming a post's author. */
  kindById: ReadonlyMap<number, "human" | "agent">;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject outside a project");
  return value;
}
