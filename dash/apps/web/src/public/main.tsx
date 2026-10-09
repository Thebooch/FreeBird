import { DASH_STYLES } from "@freebirdai/dash-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApprovalPage } from "./ApprovalPage.jsx";
import { BookingPage } from "./BookingPage.jsx";
import { StartPage } from "./StartPage.jsx";
import { publicRouteOf } from "./route.js";
import { PUBLIC_STYLES } from "./styles.js";
import { Shell, Unavailable } from "./ui.jsx";

/*
 * The public pages' own entry (`public.html`): the theme's tokens and these
 * pages' rules, and nothing of Dash's shell or chat.
 */
const style = document.createElement("style");
style.id = "pub-styles";
style.textContent = `${DASH_STYLES}\n${PUBLIC_STYLES}`;
document.head.appendChild(style);

const route = publicRouteOf(window.location.pathname, window.location.search);

const page =
  route.kind === "book" ? (
    <BookingPage workspace={route.workspace} token={route.token} />
  ) : route.kind === "type" ? (
    <StartPage workspace={route.workspace} slug={route.slug} />
  ) : route.kind === "approve" ? (
    <ApprovalPage workspace={route.workspace} token={route.token} choice={route.choice} />
  ) : (
    <Shell brand={null} width="narrow">
      <Unavailable title="There's nothing here" message="Check the link you were sent, or ask whoever sent it for a new one." />
    </Shell>
  );

createRoot(document.getElementById("root")!).render(<StrictMode>{page}</StrictMode>);
