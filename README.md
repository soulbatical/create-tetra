# create-tetra

Publieke, dependencyvrije bootstrap voor Tetra-applicaties.

```bash
npx create-tetra my-app
```

Meer is het niet. De projectnaam is kleine letters, cijfers en streepjes. Geen token om te kopiëren, geen registry om in te stellen, geen
Doppler.

## Projectnaam

De mapnaam is meestal de projectnaam. Is die geen geldige naam — `dansschool.crm`,
`Mijn CRM`, `2048` — dan leidt create-tetra er een af (`dansschool-crm`,
`mijn-crm`, `app-2048`) en zegt hij welke. Wil je zelf kiezen:

```bash
npx create-tetra . --name dansschool-crm
```

De uiteindelijke naam moet kleine letters, cijfers en streepjes bevatten en met
een letter beginnen. Die controle blijft vóór de goedkeuring staan, zodat een
naamfout je geen goedkeuring kost.

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

## Goedkeuring: hoelang geldig

De code en de link die je in de browser bevestigt, blijven geldig zolang de
goedkeuring loopt — tot 9 uur. create-tetra roteert ze niet tijdens een run: je
kunt de browser dus later openen zonder dat je link intussen een andere code
krijgt. Alleen als de server zegt dat de code echt verlopen is, vraagt de CLI een
nieuwe aan.

De CLI wacht maximaal 10 uur. Bij afloop zegt hij expliciet wat de staat is:
geannuleerd, verlopen, of mislukt na goedkeuring. Bij de eerste twee is je
goedkeuring niet verbruikt en is er niets geïnstalleerd; bij de laatste zegt de
melding wat er nog te repareren valt en welke stap je zonder nieuwe goedkeuring
kunt herhalen.

De servertermijn is 8 uur. Deze CLI accepteert een `expires_at` tot 9 uur — een
uur marge voor klokverschil — en weigert alles daarboven. Geeft de server nog de
oude 10 minuten, dan blijft de CLI werken: hij vraagt pas een nieuwe code aan als
die echt verlopen is.

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

## Tweede machine / CI zonder ~/.npmrc

Het registry-token staat in je gebruikers-npmrc op de machine waar create-tetra
heeft gedraaid. Een tweede machine heeft dat bestand niet. `npm ci` vraagt de
registry dan zonder token, en de registry antwoordt met `E404 Project not found`
— een 404, geen 401, omdat een private registry niet verraadt welke projecten
bestaan. Dat is dus geen verkeerde URL en geen auth-instelling die je moet
aanpassen: de tokenregel ontbreekt.

Controleer dat in de projectmap:

```bash
npx create-tetra --doctor
```

De doctor noemt de registry-sleutel die ontbreekt en hoe je hem overzet. Op de
machine waar create-tetra werkte:

```bash
npx create-tetra --export-credentials tetra-credentials.json
```

Kopieer dat bestand naar de tweede machine en importeer het daar:

```bash
npx create-tetra --import-credentials tetra-credentials.json
rm tetra-credentials.json
```

Het exportbestand is modus 0600 en bevat je token; verwijder het na gebruik op
beide machines. De import schrijft alleen de tokenregel voor de registry uit je
project-`.npmrc`, met dezelfde hostbeperking als de rest van create-tetra, en hij
weigert placeholders, meerregelige waarden en onbekende hosts.

Op CI is er geen gebruikers-npmrc. Daar is `ci/npmrc` het bestand: het staat in
je repo, bevat `${NPM_TOKEN}` in plaats van het token, en `railway.toml` en
`netlify.toml` wijzen `NPM_CONFIG_USERCONFIG` erheen. Zet `NPM_TOKEN` als
build-variabele (de waarde staat in je `.env`). Op een andere CI:

```bash
NPM_CONFIG_USERCONFIG="$PWD/ci/npmrc" npm ci
```

Zonder die variabele leest npm je gebruikersconfiguratie, die op een
buildmachine niet bestaat — en dan krijg je dezelfde 404.

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
- Het exportbestand van `--export-credentials` bevat je registry-token, krijgt
  modus 0600 en is bedoeld om direct na de import verwijderd te worden. Zet het
  niet in git.

## Verificatie vóór uitvoeren

- npm: https://www.npmjs.com/package/create-tetra
- bron: https://github.com/soulbatical/create-tetra
- provenance: de groene indicator op de npm-versie
