// The existing tests were written with 24-hour times ("15:00 today"). The product default is
// 12-hour; tests that cover it switch the default back themselves.
import { beforeEach } from "vitest";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { setClock } from "../src/core/time.js";

beforeEach(() => {
  DEFAULT_SETTINGS.clock = "24h";
  setClock("24h");
});
