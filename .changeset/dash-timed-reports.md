---
"@freebirdai/dash-spec": minor
"@freebirdai/dash-react": minor
---

Timed reports: a tab, or some of its widgets, emailed on a schedule with a short written summary.

- Dash spec: reports (`report.ts`). A report is a stack of blocks (a whole tab, one widget, a tracked value over a window, a note), a schedule (cron in its own time zone), recipients, who unsubscribed, an optional agent, and whether a summary is written. A tracked value is one number kept daily from a connection's records, narrowed by a filter to one record or group. Helpers `cronForCadence`, `cadenceOfCron` and `describeSchedule` turn daily, weekday, weekly and monthly schedules into cron and back; `reportDashboards` names the tabs a report draws from. Each send is a `ReportSend`.
- Dash spec: a **Send a report** workflow step (`send.report`) and a `report` setting kind.
- Dash react: the Reports pop-up's styles (`styles-reports.ts`), part of `DASH_REACT_STYLES`: the list of a tab's reports and the editor with its email preview.
