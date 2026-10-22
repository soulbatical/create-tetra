# Changelog

## 0.2.0

Drie punten uit cursist-feedback, plus de CLI die de nieuwe servertermijn aankan.

### Tweede machine (A3)

- `npx create-tetra --doctor` legt uit waarom `npm ci` op een tweede machine
  `E404 Project not found` geeft: de tokenregel ontbreekt, de URL is niet fout.
- `--export-credentials <bestand>` schrijft de registry-token van de eerste
  machine naar een bestand met modus 0600.
- `--import-credentials <bestand>` zet dat bestand op de tweede machine, met
  dezelfde hostbeperking als de rest van create-tetra.
- Een 404 tijdens de eigen `npm install` verwijst nu naar `--doctor`.
- README-sectie "Tweede machine of CI zonder ~/.npmrc", inclusief
  `NPM_CONFIG_USERCONFIG="$PWD/ci/npmrc"` voor CI.

### Goedkeuring (A2)

- De CLI accepteert een `expires_at` tot 9 uur; de bovengrens blijft als
  veiligheidsklep staan en weigert alles daarboven.
- De code en link worden niet meer geroteerd zolang de autorisatie geldig is.
  Een nieuwe code wordt alleen aangevraagd als de server `expired` zegt.
- De wachttijd is begrensd op 10 uur in plaats van een renewal-count die per
  TTL anders uitpakte.
- De wachtregel noemt de resterende tijd; `--help` noemt de 9 uur geldigheid en
  de 10 uur wachttijd.
- De melding na afloop zegt expliciet wat de staat is: geannuleerd, verlopen, of
  mislukt na goedkeuring, met wat je zonder nieuwe goedkeuring kunt herhalen.

### Projectnaam (A1)

- `--name <naam>` kiest de projectnaam expliciet.
- Zonder `--name` leidt de CLI een slug af uit de mapnaam (`dansschool.crm` →
  `dansschool-crm`) en toont welke. De bestaande validatie op de uiteindelijke
  naam blijft vóór de goedkeuring staan.
