import type { Locale } from "./routing";
import type messages from "../../messages/en.json";

// Makes t("some.key") a compile error when the key does not exist.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
  }
}
