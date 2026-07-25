# Votes de l'Assemblée nationale — `votes.json`

Ce dépôt contient un pipeline (`update_votes.py` + GitHub Action) qui télécharge
l'archive officielle des scrutins de l'Assemblée nationale
([data.assemblee-nationale.fr](https://data.assemblee-nationale.fr/travaux-parlementaires/votes))
et la transforme en un fichier unique **`data/votes.json`**, compact et
directement exploitable par une application (ex. un dashboard Streamlit).

Le fichier est régénéré automatiquement chaque jour par la GitHub Action
`.github/workflows/update-votes.yml` et committé dans le dépôt. Une app tierce
n'a donc rien à télécharger ni à parser elle-même : elle lit simplement ce
fichier JSON.

## 1. Où trouver le fichier

Une fois le dépôt poussé sur GitHub, `data/votes.json` est accessible en
lecture brute (raw) à cette URL, sans authentification :

```
https://raw.githubusercontent.com/<votre-org>/<votre-repo>/main/data/votes.json
```

Remplacez `<votre-org>/<votre-repo>` par le chemin réel du dépôt. C'est cette
URL que l'app Streamlit doit interroger.

## 2. Structure du fichier

```jsonc
{
  "meta": {
    "source": "https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip",
    "legislature": 17,
    "generated_at": "2026-07-25T12:00:00+00:00",
    "count": 8434
  },
  "scrutins": [
    {
      "numero": 8190,
      "uid": "VTANR5L17V8190",
      "date": "2026-07-21",
      "seance": null,
      "titre": "l'amendement n° 901 (rect.) du Gouvernement ...",
      "type": "Scrutin public ordinaire",
      "demandeur": "Gouvernement",
      "sort": "adopté",
      "synthese": {
        "votants": 570,
        "pour": 312,
        "contre": 245,
        "abstentions": 13,
        "nonVotants": 7
      },
      "groupes": [
        {
          "organe": "PO845418",
          "effectif": 88,
          "pour": 80,
          "contre": 0,
          "abstentions": 2,
          "nonVotants": 1
        }
      ]
    }
  ]
}
```

### Champ par champ

| Champ | Type | Description |
|---|---|---|
| `meta.source` | string | URL de l'archive officielle utilisée pour générer le fichier |
| `meta.legislature` | int | Numéro de la législature (17 = législature courante) |
| `meta.generated_at` | string ISO 8601 | Horodatage UTC de la dernière génération |
| `meta.count` | int | Nombre total de scrutins dans le fichier |
| `scrutins[].numero` | int | Numéro du scrutin (identifiant principal, unique) |
| `scrutins[].uid` | string | Identifiant technique AN (ex. `VTANR5L17V8190`) |
| `scrutins[].date` | string `YYYY-MM-DD` | Date du scrutin |
| `scrutins[].titre` | string | Objet du vote (texte, amendement, motion...) |
| `scrutins[].type` | string | Type de scrutin (ordinaire, solennel, motion de censure...) |
| `scrutins[].demandeur` | string \| null | Groupe/organe à l'origine de la demande de scrutin public |
| `scrutins[].sort` | string \| null | Résultat (`adopté`, `rejeté`...) quand applicable |
| `scrutins[].synthese` | object | Décompte global des voix (`votants`, `pour`, `contre`, `abstentions`, `nonVotants`) |
| `scrutins[].groupes[]` | array | Détail du vote par groupe politique |
| `scrutins[].groupes[].organe` | string | Identifiant du groupe politique (référence AN, ex. `PO845418`) |
| `scrutins[].groupes[].effectif` | int | Nombre de députés du groupe |
| `scrutins[].groupes[].pour/contre/abstentions/nonVotants` | int | Décompte du groupe pour ce scrutin |

> Par défaut, le détail nominatif (vote individuel de chaque député) n'est
> **pas** inclus, pour garder le fichier compact. Si le script a été généré
> avec `--with-nominatif`, chaque `groupes[]` peut aussi contenir une clé
> `nominatif: {pour: [...], contre: [...], abstention: [...], nonVotant: [...]}`
> listant les identifiants (`acteurRef`) des députés.

Les identifiants de groupe (`organe`, ex. `PO845418`) ne sont pas les sigles
lisibles (« RN », « LFI »...) : ce sont les références internes AN. Pour les
afficher lisiblement, il faut les croiser avec le jeu de données *Acteurs /
Organes* de l'AN (ou maintenir une table de correspondance statique
`organe -> sigle` côté app, plus simple si la liste des groupes change peu).

## 3. Requêter le fichier depuis Streamlit

### Chargement simple avec cache

```python
import requests
import streamlit as st
import pandas as pd

VOTES_URL = "https://raw.githubusercontent.com/<votre-org>/<votre-repo>/main/data/votes.json"

@st.cache_data(ttl=3600)  # revérifie toutes les heures
def load_votes():
    data = requests.get(VOTES_URL, timeout=30).json()
    return data["meta"], data["scrutins"]

meta, scrutins = load_votes()
st.caption(f"{meta['count']} scrutins — mis à jour le {meta['generated_at']}")
```

### Convertir en DataFrame pour filtrer/agréger

```python
df = pd.json_normalize(
    scrutins,
    sep="_",
)
df["date"] = pd.to_datetime(df["date"])

# Exemples de requêtes
adoptes = df[df["sort"] == "adopté"]
periode = df[(df["date"] >= "2026-01-01") & (df["date"] <= "2026-06-30")]
recherche_titre = df[df["titre"].str.contains("santé", case=False, na=False)]
```

### Détail par groupe politique (aplatir `groupes[]`)

```python
lignes = []
for s in scrutins:
    for g in s["groupes"]:
        lignes.append({
            "numero": s["numero"],
            "date": s["date"],
            "titre": s["titre"],
            "organe": g["organe"],
            "pour": g["pour"],
            "contre": g["contre"],
            "abstentions": g["abstentions"],
        })
df_groupes = pd.DataFrame(lignes)

# Ex : total des votes "pour" d'un groupe donné sur toute la période
df_groupes[df_groupes["organe"] == "PO845418"]["pour"].sum()
```

### Widgets Streamlit typiques

```python
col1, col2 = st.columns(2)
with col1:
    date_min, date_max = st.date_input(
        "Période", value=(df["date"].min(), df["date"].max())
    )
with col2:
    sort_filtre = st.multiselect(
        "Résultat", options=df["sort"].dropna().unique(), default=None
    )

resultat = df[
    (df["date"] >= pd.Timestamp(date_min))
    & (df["date"] <= pd.Timestamp(date_max))
    & (df["sort"].isin(sort_filtre) if sort_filtre else True)
]
st.dataframe(resultat[["numero", "date", "titre", "sort", "synthese_pour", "synthese_contre"]])
```

## 4. Bonnes pratiques

- **Toujours passer par `st.cache_data`** (avec un `ttl`) pour éviter de
  retélécharger le fichier à chaque interaction utilisateur — le fichier
  entier fait quelques Mo, inutile de le refetcher en boucle.
- Le fichier est **trié par `numero` croissant** : pas besoin de re-trier
  côté app sauf besoin spécifique.
- `meta.generated_at` permet d'afficher un indicateur de fraîcheur des
  données dans l'interface (« dernière mise à jour : ... »).
- Le fichier grossit d'environ un scrutin par jour de séance : le lire en
  entier reste largement suffisant, pas besoin de pagination côté source.

## 5. Régénérer le fichier manuellement

```bash
python update_votes.py --output data/votes.json
```

Le script est idempotent : relancé, il ajoute les nouveaux scrutins et met à
jour ceux qui ont changé sans dupliquer les entrées existantes. Voir
`update_votes.py --help` pour les options (`--legislature`,
`--with-nominatif`, `--pretty`).
