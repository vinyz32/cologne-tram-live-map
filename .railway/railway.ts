import { defineRailway, github, project, service } from "railway/iac";

export default defineRailway(() => {
  const web = service("cologne-tram-live-map", {
    source: github("vinyz32/cologne-tram-live-map", { branch: "main" }),
    start: "cologne-tram-live-map",
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    replicas: 1,
  });

  return project("cologne-tram-live-map", {
    resources: [web],
  });
});
