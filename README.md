# segur-ping

**Surveillance continue de la disponibilité réseau et de la latence** à des fins
d'audit. Ping une liste d'adresses IP chaque minute, stocke les résultats sous
forme d'un fichier JSON par jour, et publie un graphique + un tableau de synthèse
léger sur **GitHub Pages** toutes les 2 heures (ou manuellement) — la collecte
par minute est orchestrée par un pipeline **Jenkins auto-hébergé** (la partie
coûteuse ne consomme donc aucun quota GitHub Actions). Un unique workflow Actions
léger se contente de déployer le site (~12 exécutions courtes par jour).

## Ce qui est mesuré

Par cible, chaque minute (`packets` échos ICMP, 4 par défaut) :

| Champ | Signification |
|---|---|
| `ts`, `date`, `hour` | Horodatage local (Europe/Paris), date et heure |
| `ip`, `label` | Cible |
| `sent`, `recv`, `loss_pct` | Paquets envoyés/reçus, taux de perte % |
| `rtt_min/avg/max` | Temps aller-retour en ms (`null` si injoignable) |
| `ok` | `true` si au moins une réponse est revenue |

Les données résident dans `docs/data/YYYY-MM-DD.json` (conservées indéfiniment —
c'est l'enregistrement d'audit). Le tableau de bord lit `docs/data/index.json`
(un manifeste + une synthèse glissante sur 24 h) ainsi que les fichiers
journaliers pour la plage sélectionnée.

## Arborescence

```
config.json          cibles, nombre de paquets, délai d'attente, fuseau horaire
scripts/ping.js      lance le ping système, analyse RTT + perte (indépendant de la locale)
scripts/collect.js   ping toutes les cibles, ajoute au JSON journalier du jour
scripts/build-site.js  reconstruit docs/data/index.json (manifeste + synthèses)
docs/                racine GitHub Pages (index.html, app.js, vendor/uPlot.*)
Jenkinsfile          unique job cron à la minute sur l'agent bookwormjdk17
Dockerfile           OPTIONNEL — conteneur de dev local uniquement ; NON utilisé par Jenkins
```

L'agent Jenkins (`bookwormjdk17`) dispose déjà de **git + Node 18 + ping**, donc
le pipeline exécute les scripts Node directement sur l'agent — sans Docker.

## Configuration

Éditez `config.json` :

```json
{
  "targets": [
    { "ip": "8.8.8.8", "label": "Google DNS" },
    { "ip": "10.0.0.5", "label": "Service X", "port": 8443 }
  ],
  "method": "icmp",
  "port": 443,
  "packets": 4,
  "timeoutSec": 2,
  "publishEveryHours": 2,
  "timezone": "Europe/Paris"
}
```

- **`method`** : `"icmp"` (`ping` système, nécessite les privilèges/l'égress
  ICMP) ou `"tcp"` (mesure le RTT du handshake TCP — **aucun privilège, passe la
  plupart des pare-feux**). Utilisez `tcp` sur les agents verrouillés où l'ICMP
  est bloqué.
- **`port`** : port TCP par défaut pour la méthode `tcp` ; surchargeable par
  cible avec un champ `"port"`. Ignoré pour `icmp`.

## Exécution locale (vérification)

```bash
node scripts/ping.js 8.8.8.8      # test rapide de l'analyseur
node scripts/collect.js           # ajoute un lot à docs/data/<aujourd'hui>.json
node scripts/build-site.js        # (re)construit docs/data/index.json
# servir le tableau de bord :
cd docs && python -m http.server 8080   # ouvrir http://localhost:8080
```

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
   - Le pipeline épingle `agent { label 'bookwormjdk17' }` (git + Node 18 + ping).
   - Il réutilise le **credential GitHub App** du multibranche pour le push.
     L'id est défini en haut du `Jenkinsfile` par `GIT_CRED_ID = 'ans-forge'`
     — changez-le là si l'indexation des branches utilise un id de credential
     différent.
   - Aucun Docker et aucun secret supplémentaire requis.

Le déclencheur `cron('* * * * *')` à l'intérieur du Jenkinsfile le pilote :
chaque minute il ping, ajoute au JSON journalier, commit et push. Le tableau de
bord se rafraîchit quant à lui selon la planification Pages toutes les 2 heures.

> **Si toutes les cibles apparaissent `down` / 100 % de perte** (comme sur un
> agent verrouillé), l'ICMP est bloqué pour l'utilisateur jenkins (privilèges ou
> égress du pare-feu). Soit accordez le ping non privilégié
> (`net.ipv4.ping_group_range` / `setcap` sur le binaire ping), soit définissez
> **`"method": "tcp"`** dans `config.json` — le probing par handshake TCP ne
> nécessite aucun privilège et passe la plupart des pare-feux. Le collecteur
> journalise la raison exacte lorsque rien n'est joignable.

## Comment ça reste économique et propre

- Les données sont commitées + pushées **chaque minute** (piste d'audit en
  quasi temps réel), mais ces commits ne touchent que `docs/data/**`.
- Le **workflow Pages ignore `docs/data/**`** et déploie selon une
  **planification de 2 h**, donc les push de données par minute ne déclenchent
  jamais de déploiement → l'usage Actions reste ~12/jour.
- Les logs de build sont rotés automatiquement (`buildDiscarder`) ; les
  **données d'audit sont dans l'historique git**.
- La bibliothèque de graphiques (uPlot) est **vendorisée** (fonctionne hors
  ligne). Les polices/icônes DSFR se chargent depuis un CDN et se dégradent
  gracieusement vers les polices système si celui-ci est inaccessible.

## Notes / limites

- **Volume de commits** : le push par minute ≈ 1440 commits/jour sur `main`.
  C'est le coût des données en quasi temps réel ; l'historique est la piste
  d'audit. (Si c'est trop, augmentez l'intervalle du cron ou groupez les
  commits.)
- Minute manquée : si une exécution dépasse 60 s, `disableConcurrentBuilds`
  saute le tick suivant (visible comme un trou dans le graphique). Les sondes
  s'exécutent en parallèle pour garder les runs rapides.
- Le tableau de bord reflète les données au dernier déploiement Pages
  bihoraire, même si les données sous-jacentes dans git sont fraîches à la
  minute.
