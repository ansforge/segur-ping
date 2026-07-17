# segur-ping

**Surveillance continue des codes de statut HTTP** à des fins d'audit. `curl`
une liste d'URLs chaque minute, stocke **un fichier JSON par URL** (dernier état)
**et** une **série temporelle journalière** (pour tracer les valeurs dans le
temps), et publie graphiques + tableau de synthèse sur **GitHub Pages** toutes les 2 heures
(ou manuellement) — la collecte par minute est orchestrée par un pipeline
**Jenkins auto-hébergé** (la partie coûteuse ne consomme donc aucun quota GitHub
Actions). Un unique workflow Actions léger se contente de déployer le site
(~12 exécutions courtes par jour).

## Ce qui est mesuré

Par URL, chaque minute (un `curl` sans suivi de redirection par défaut) :

| Champ | Signification |
|---|---|
| `id` | Identifiant stable dérivé de l'URL (`<host>-<hash8>`), sert de nom de fichier |
| `url`, `label`, `domain` | URL, libellé, domaine (host de l'URL par défaut) |
| `ts` | Horodatage ISO de la relève |
| `http_code` | Code de statut HTTP (`null` si aucune réponse : DNS/TLS/timeout) |
| `ms` | Temps total du `curl` en ms |
| `ok` | `true` si `curl` a réussi **et** `200 ≤ http_code < 400` |
| `err` | Message d'erreur le cas échéant (`HTTP 404`, timeout curl…) |
| `health` | Statut global si le corps est un healthcheck JSON (`UP`/`DOWN`), sinon `null` |
| `checks` | Sous-statuts par check (`{ "WADO-RS": "UP", … }`) si présents, sinon `null` |

Si le corps de la réponse est un JSON de type healthcheck
(`{ "status": "DOWN", "checks": { "LISTEBLANCHE": "DOWN", … } }`), le collecteur
en extrait le statut global (`health`) et chaque sous-check (`checks`). L'état
affiché privilégie `health` sur le code HTTP (un 200 avec `health=DOWN` reste
« dégradé »), et chaque check apparaît comme une pastille UP/DOWN dans le tableau.

Le collecteur écrit **deux** choses par relève : le dernier résultat de chaque
URL dans `docs/data/http/<id>.json` (écrasé — alimente le tableau), et une ligne
compacte par URL ajoutée au fichier journalier `docs/data/<jour>.json`
(historique — alimente les graphiques temporels). Le tableau de bord lit
`docs/data/index.json` — un manifeste listant toutes les URLs avec leur dernier
statut, la liste des domaines (menu déroulant) et la liste des jours disponibles.

## Arborescence

```
urls.json               URLs supervisées, timeout, concurrence, suivi des redirections
scripts/http-targets.js loader partagé : id stable + domaine par URL
scripts/collect-http.js curl toutes les URLs -> snapshot docs/data/http/<id>.json + historique docs/data/<jour>.json
scripts/build-site.js   reconstruit docs/data/index.json (manifeste + domaines + jours)
docs/                   racine GitHub Pages (index.html, app.js, vendor/uPlot.*)
Jenkinsfile             unique job cron à la minute sur l'agent Kubernetes bookormjdk17persistent
Dockerfile              OPTIONNEL — conteneur de dev local uniquement ; NON utilisé par Jenkins
```

## Configuration

Éditez `urls.json` :

```json
{
  "timezone": "Europe/Paris",
  "timeoutSec": 10,
  "concurrency": 50,
  "followRedirects": false,
  "urls": [
    { "url": "https://exemple.esante.gouv.fr/health", "label": "Service X" },
    { "url": "https://autre.example.org/", "label": "Service Y", "domain": "example.org" }
  ]
}
```

- **`url`** : URL complète à interroger.
- **`label`** : libellé affiché (défaut : l'URL).
- **`domain`** *(optionnel)* : regroupe l'URL dans le menu déroulant. Par défaut,
  le host de l'URL — plusieurs chemins d'un même host se regroupent donc
  automatiquement.
- **`timeoutSec`** : `--connect-timeout` et `--max-time` de `curl`.
- **`concurrency`** : nombre de `curl` simultanés (borne le temps de collecte).
- **`followRedirects`** : `true` pour suivre les 3xx (`curl -L`) ; sinon un
  301/302 est rapporté tel quel.

On interroge le binaire **`curl`** (et non un `fetch` Node) volontairement : il
respecte les variables `HTTP(S)_PROXY` du pod et le magasin de CA système (où
sont injectées les CA IGC Santé), ce qu'un `fetch` ne ferait pas sans config.

## Exécution locale (vérification)

```bash
node scripts/collect-http.js     # curl chaque URL -> docs/data/http/<id>.json
node scripts/build-site.js       # (re)construit docs/data/index.json
# servir le tableau de bord (mettre DATA_BASE='./data' dans docs/app.js pour du local) :
cd docs && python -m http.server 8080   # ouvrir http://localhost:8080
```

Par défaut, `docs/app.js` lit `index.json` depuis le **contenu brut de git**
(`raw.githubusercontent.com`, dernier commit) et non depuis le snapshot Pages,
pour que le bouton « Actualiser » affiche des statuts quasi-live sans redéploiement.

## Configuration initiale Jenkins / GitHub

1. **GitHub Pages** : le workflow `.github/workflows/pages.yml` active
   automatiquement Pages (source Actions) lors de sa première exécution via
   `configure-pages` avec `enablement: true`. Il déploie `docs/` selon une
   **planification toutes les 2 heures**, lors d'un *Run workflow* manuel, et sur
   les push modifiant le site lui-même — mais **pas** sur les commits par minute
   de `docs/data/**` (exclus via `!docs/data/**`), afin que les push de données
   fréquents ne déclenchent jamais de déploiement.
   - Si l'activation automatique est bloquée par une politique d'organisation,
     réglez-la manuellement une fois :
     *Settings → Pages → Source = **GitHub Actions*** puis relancez le workflow.
2. **Job Jenkins** : un **Pipeline multibranche** sur `ansforge/segur-ping`,
   chemin de script `Jenkinsfile` (déjà configuré en tant que
   `ANS/Transverse/Forge/ping-segur`).
   - Le pipeline acquiert `agent { label 'bookormjdk17persistent' }` (pod
     Kubernetes persistant avec git + Node + curl).
   - Il réutilise le **credential GitHub App** du multibranche pour le push.
     L'id est défini en haut du `Jenkinsfile` par
     `GIT_CRED_ID = 'GithubTokenAnsForge'` — changez-le là si l'indexation des
     branches utilise un id de credential différent.
   - Aucun Docker et aucun secret supplémentaire requis.

Le déclencheur `cron('* * * * *')` à l'intérieur du Jenkinsfile le pilote :
chaque minute il `curl` toutes les URLs, écrase les fichiers par URL, reconstruit
le manifeste, commit et push. Le tableau de bord se rafraîchit quant à lui selon
la planification Pages toutes les 2 heures (ou instantanément via « Actualiser »,
qui relit git directement).

> **Si toutes les URLs apparaissent injoignables** (aucune réponse), c'est
> presque toujours l'égress/proxy ou la confiance CA du pod, pas une panne réelle.
> Vérifiez `HTTP(S)_PROXY` et que `curl` dans le pod fait confiance aux CA des
> cibles. Le collecteur journalise un avertissement lorsque 0 URL est OK.

## Comment ça reste économique et propre

- Les données sont commitées + pushées **chaque minute** (piste d'audit en
  quasi temps réel), mais ces commits ne touchent que `docs/data/**`.
- Le **workflow Pages ignore `docs/data/**`** et déploie selon une
  **planification de 2 h**, donc les push de données par minute ne déclenchent
  jamais de déploiement → l'usage Actions reste ~12/jour.
- Les logs de build sont mis en rotation automatiquement (`buildDiscarder`) ; les
  **données d'audit sont dans l'historique git**.
- Le front est **sans build ni dépendance JS externe**. Les polices/icônes DSFR
  se chargent depuis un CDN et se dégradent gracieusement vers les polices
  système si celui-ci est inaccessible.

## Notes / limites

- **Volume de commits et de fichiers** : le push par minute ≈ 1440 commits/jour
  sur `main`. Chaque relève réécrit jusqu'à ~900 snapshots par URL (taille
  **bornée**) **et** ajoute ~900 lignes au fichier journalier `docs/data/<jour>.json`
  (qui, lui, **grossit** : ~900 × 1440 lignes/jour à pleine échelle). C'est le
  coût de l'historique temporel. Les vieux fichiers journaliers peuvent être
  élagués si nécessaire.
- **Temps de collecte** : borné par `concurrency`. Avec 900 URLs, `concurrency`
  50 et `timeoutSec` 10, le pire cas (toutes en timeout) ≈ 900/50 × 10 s = 180 s.
  Ajustez `concurrency`/`timeoutSec` pour rester sous le timeout du stage Jenkins.
- Minute manquée : si une exécution dépasse 60 s, `disableConcurrentBuilds`
  saute le tick suivant. Les `curl` s'exécutent en parallèle pour garder les runs
  rapides.
- Le tableau de bord servi par Pages reflète les données au dernier déploiement
  bihoraire ; « Actualiser » relit git directement pour afficher le quasi-live.
