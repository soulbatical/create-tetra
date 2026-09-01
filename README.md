# create-tetra

Publieke, dependencyvrije bootstrap voor Tetra-applicaties.

> Availability: nog niet beschikbaar. `create-tetra@next` kan al op npm staan als
> gereserveerde naamclaim; die prerelease installeert bewust nog niets en is geen
> werkende bootstrap. Gebruik het commando hieronder pas als de npm-packagepagina,
> de publieke bron en provenance zichtbaar zijn op een `latest`-versie.

```bash
npx create-tetra@latest
```

npm vraagt eerst zichtbaar toestemming om de publieke bootstrap uit te voeren.
Daarna opent de CLI `https://app.tetrasaas.com`, waar de gebruiker organisatie,
licentie en gevraagde installatieactie ziet en expliciet goedkeurt.

De publieke package bevat geen private Tetra-dependencies, registryconfiguratie,
package-token of licentiewaarde. Zulke gegevens mogen nooit in CLI-output of het
bevroren installatieresultaat verschijnen.

## Verificatie vóór uitvoeren

- npm: https://www.npmjs.com/package/create-tetra
- bron: https://github.com/soulbatical/create-tetra
- provenance: zichtbaar via de groene provenance-indicator op de npm-versie

Tot alle drie werken, is `create-tetra` niet beschikbaar.

## Uitkomst van een installatie

De CLI meldt nooit meer dan er werkelijk gebeurd is. Het bevroren resultaat wordt
samengevat als `completed`, `partial`, `planned` of `failed`; zolang geen enkel doel
daadwerkelijk geconfigureerd is, zegt de CLI expliciet dat er niets is geinstalleerd
en levert `create-tetra` bij een mislukking exitcode 1.
