import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Use these instead of next/link and next/navigation: they add the locale to every URL.
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
