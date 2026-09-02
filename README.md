# create-tetra

Publieke, dependencyvrije bootstrap voor Tetra-applicaties.

```bash
npx create-tetra my-app
```

Meer is het niet. De projectnaam is kleine letters, cijfers en streepjes. Geen token om te kopiëren, geen registry om in te stellen, geen
Doppler.

## Wat er gebeurt

1. De CLI vraagt een goedkeuring aan en opent `https://tetrasaas.com`.
2. Daar zie je welke organisatie, licentie en welk project het betreft, plus een
   bevestigingscode die je met je terminal vergelijkt. Je keurt goed of weigert.
3. Na goedkeuring haalt de CLI eenmalig jouw eigen toegang op: een read-only
   registry-token dat alleen voor jouw account geldt, en je licentiesleutel.
4. De CLI draait de Tetra-scaffolder en schrijft daarna jouw registry-toegang en
   licentie weg — in die volgorde, zodat jouw configuratie het laatste woord heeft.
   Tot slot draait hij de eerste `npm install` voor je.

De organisatiebrede tokens van Soulbatical komen hier nooit aan te pas. Je krijgt
je eigen, intrekbare toegang.

## Wat er waar terechtkomt

npm leest configuratie uit je project en credentials uit je gebruikersaccount, en
create-tetra volgt die scheiding:

- `<project>/.npmrc` wijst de `@soulbatical`-scope naar jouw registry. Geen token,
  geen placeholder — dit bestand mag je gewoon committen.
- Je npm-gebruikersconfiguratie krijgt jouw registry-token, op de plek waar
  `npm login` het ook zet. Daardoor blijft elke volgende `npm install` werken
  zonder dat je iets exporteert. Bestaande regels voor andere registries blijven
  behouden; alleen een eerdere regel voor deze registry wordt vervangen. Het
  bestand wordt atomair vervangen, dus een mislukte schrijfactie laat je
  bestaande configuratie ongemoeid, en een symlink naar je dotfiles blijft een
  symlink — ook als het doel nog niet uitgecheckt is. Omdat er vanaf dat moment
  een token in staat, krijgt het bestand modus 0600.
- Welk bestand dat is, wordt bewust alleen uit `NPM_CONFIG_USERCONFIG` in je
  omgeving gelezen. Niet via `npm config get` en niet via de `--userconfig`-vlag:
  npm lost die op tegen de map waar je toevallig staat, en een `.npmrc` in een
  gekloonde repo kan daarmee bepalen waar jouw persoonlijke token belandt. Een
  waarde die daardoor onbruikbaar is — relatief, of binnen je huidige map — wordt
  niet gevolgd, en create-tetra zegt dan welke waarde het overslaat en waar het
  token in plaats daarvan heen gaat. Heb je een afwijkende npm-setup, dan is dat
  de knop om aan te draaien.
- De `npm install` die create-tetra voor je draait wordt op datzelfde bestand
  gericht, zodat de plek waar het token staat en de plek waar npm kijkt niet uit
  elkaar kunnen lopen.
- `<project>/ci/npmrc` wijst diezelfde scope naar jouw registry en zet er wel een
  authenticatieregel bij, met `${NPM_TOKEN}` als placeholder in plaats van je
  token. Een buildmachine heeft geen gebruikersconfiguratie en heeft die regel
  dus nodig; `railway.toml` en `netlify.toml` wijzen `NPM_CONFIG_USERCONFIG`
  daarheen. Netlify installeert voordat het je buildcommando draait, dus dit moet
  een bestand in je repository zijn. In je project-`.npmrc` zou dezelfde regel
  juist schade doen: npm slaat een niet-opgeloste `${NPM_TOKEN}` niet over maar
  stuurt hem letterlijk mee, en dan krijgt elke ontwikkelaar die de variabele
  niet exporteert een 401 op een verder werkende `~/.npmrc`. Committen dus, en
  op Railway en Netlify alleen nog `NPM_TOKEN` als build-variabele zetten.
- `<project>/.env` krijgt je licentiesleutel, en `NPM_TOKEN` voor buildmachines
  waar geen gebruikersconfiguratie bestaat. npm leest `.env` niet, dus die
  variabele doet uit zichzelf niets: `ci/npmrc` is het bestand dat hem uitgeeft.
  Dit bestand hoort niet in git; create-tetra zet het voor je in `.gitignore`.

create-tetra draait de eerste `npm install` zelf, zodat je project bewezen
installeerbaar is voordat je iets te horen krijgt.

## Veiligheidsgrenzen

- Vóór jouw goedkeuring haalt deze package niets privés op en leest hij geen
  registryconfiguratie. Hij heeft geen dependencies.
- De browser wordt alleen geopend voor `https://tetrasaas.com`; een andere
  origin wordt geweigerd.
- De registry moet HTTPS zijn, mag geen inloggegevens in de URL dragen, en moet
  op een van de hosts staan waar Tetra daadwerkelijk vandaan gepubliceerd wordt.
  Er is geen uitzondering, ook niet voor localhost. Een control plane kan je
  installatie dus niet naar een derde partij sturen.
- Elke regel die in npm-configuratie belandt wordt geparsed en vergeleken met die
  registry: precies één registry-regel, precies één tokenregel voor precies die
  host, verder niets. Onzichtbare stuur- en bidi-tekens worden geweigerd, en
  alles wat een `.env`-regel wordt mag geen nieuwe regel bevatten.
- De helper-installatie draait met `--ignore-scripts`.
- Token, licentiesleutel en goedkeuringsbewijs verschijnen nooit in de output.

## Verificatie vóór uitvoeren

- npm: https://www.npmjs.com/package/create-tetra
- bron: https://github.com/soulbatical/create-tetra
- provenance: de groene indicator op de npm-versie
