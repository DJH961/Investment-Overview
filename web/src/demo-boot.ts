/**
 * Boot-time side effect for the public demo-only build (`VITE_DEMO_ONLY=1`):
 * install the shifted demo clock before any other module reads the time. It must
 * be the first import of the entry point. A no-op in every other build.
 */
import { installDemoClock } from "./demo-clock";
import { isDemoOnly } from "./demo";

if (isDemoOnly()) installDemoClock();
