# create-tetra

Publieke, dependencyvrije bootstrap voor Tetra-applicaties.

> Availability: nog niet beschikbaar. `create-tetra@next` staat op npm als
> gereserveerde naamclaim; die prerelease installeert bewust niets. Het commando
> hieronder werkt zodra er een `latest`-versie is.

```bash
npx create-tetra my-app
```

Meer is het niet. Geen token om te kopiëren, geen registry om in te stellen, geen
Doppler.

## Wat er gebeurt

1. De CLI vraagt een goedkeuring aan en opent `https://www.tetrasaas.com`.
2. Daar zie je welke organisatie, licentie en welk project het betreft, plus een
   bevestigingscode die je met je terminal vergelijkt. Je keurt goed of weigert.
3. Na goedkeuring haalt de CLI eenmalig jouw eigen toegang op: een read-only
   registry-token dat alleen voor jouw account geldt, en je licentiesleutel.
4. De CLI maakt het project aan, schrijft `.npmrc` en `.env`, en draait de
   Tetra-scaffolder.

De organisatiebrede tokens van Soulbatical komen hier nooit aan te pas. Je krijgt
je eigen, intrekbare toegang.

## Wat er in je project belandt

`.npmrc` wijst de `@soulbatical`-scope naar jouw registry en verwijst voor het
token naar `${NPM_TOKEN}`. Het token zelf staat in `.env`, samen met je
licentiesleutel — dus het bestand dat meestal wél in git belandt bevat geen
geheim. Zet `.env` in je `.gitignore` en houd het daar.

## Veiligheidsgrenzen

- Vóór jouw goedkeuring haalt deze package niets privés op en leest hij geen
  registryconfiguratie. Hij heeft geen dependencies.
- De browser wordt alleen geopend voor `https://www.tetrasaas.com`; een andere
  origin wordt geweigerd.
- Antwoorden van de control plane worden strikt gevalideerd. Een `.npmrc`-sjabloon
  dat een andere registry of een extra npm-directive probeert mee te smokkelen
  wordt geweigerd, net als onzichtbare stuur- en bidi-tekens.
- Token, licentiesleutel en goedkeuringsbewijs verschijnen nooit in de output.

## Verificatie vóór uitvoeren

- npm: https://www.npmjs.com/package/create-tetra
- bron: https://github.com/soulbatical/create-tetra
- provenance: de groene indicator op de npm-versie
