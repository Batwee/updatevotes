#!/usr/bin/env python3
"""
update_votes.py
================

Télécharge l'archive JSON officielle des scrutins de l'Assemblée nationale
(data.assemblee-nationale.fr), extrait les ~8 400 fichiers JSON (un par
scrutin) et les fusionne en un unique fichier `votes.json` compact,
optimisé pour être consommé par une application (site web, appli mobile,
API, etc.).

Le script est idempotent : on peut le relancer à tout moment (par ex. via
un cron ou une GitHub Action programmée) pour récupérer les nouveaux
scrutins et mettre à jour ceux qui auraient changé, sans dupliquer les
données déjà présentes.

Usage
-----
    python update_votes.py                  # met à jour data/votes.json
    python update_votes.py --output out.json
    python update_votes.py --legislature 16 # archive d'une législature passée
    python update_votes.py --with-nominatif # inclut le détail vote par député
    python update_votes.py --pretty         # JSON indenté (debug), sinon compact

Sortie
------
Un fichier JSON de la forme :

{
  "meta": {
    "source": "https://data.assemblee-nationale.fr/...",
    "legislature": 17,
    "generated_at": "2026-07-25T12:00:00+00:00",
    "count": 8434
  },
  "scrutins": [
    {
      "numero": 8190,
      "date": "2026-07-21",
      "titre": "...",
      "type": "Scrutin public ordinaire",
      "demandeur": "...",
      "sort": "adopté",
      "synthese": {"votants": 570, "pour": 300, "contre": 250, "abstentions": 20},
      "groupes": [
        {
          "organe": "PO845418",
          "sigle": "RN",
          "nom": "Rassemblement National",
          "effectif": 88,
          "pour": 88,
          "contre": 0,
          "abstentions": 2,
          "nonVotants": 1,
          "position": "pour"
        }
      ]
    },
    ...
  ]
}

Le fichier est trié par numéro de scrutin croissant et ne conserve que les
informations utiles à l'affichage/l'analyse (les listes nominatives brutes,
très volumineuses et largement redondantes avec les décomptes de synthèse,
ne sont pas conservées par défaut — voir --with-nominatif pour les inclure).

Pour chaque groupe politique, le champ `position` résume en un mot comment
le groupe a voté majoritairement (`pour`, `contre` ou `abstention`) — pratique
pour un affichage rapide type "LFI a voté contre, RN a voté pour" — tandis
que les compteurs détaillés restent disponibles pour un usage plus fin. Les
sigles (`RN`, `LFI-NUPES`, ...) sont récupérés depuis le jeu de données
"Acteurs et organes" de l'AN et mis en cache localement.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

LOG = logging.getLogger("update_votes")

# L'Assemblée publie l'archive de la législature en cours sans suffixe,
# et les archives passées avec le chiffre romain de la législature.
ROMAN = {14: "XIV", 15: "XV", 16: "XVI"}


def build_zip_url(legislature: int) -> str:
    base = "https://data.assemblee-nationale.fr/static/openData/repository"
    if legislature in ROMAN:
        return f"{base}/{legislature}/loi/scrutins/Scrutins_{ROMAN[legislature]}.json.zip"
    # législature courante (pas de suffixe dans le nom de fichier)
    return f"{base}/{legislature}/loi/scrutins/Scrutins.json.zip"


def build_organes_zip_url(legislature: int) -> str:
    """Archive 'Acteurs et organes séparés' : contient un fichier JSON par
    organe (dont les groupes politiques), avec leur sigle et leur nom complet."""
    base = "https://data.assemblee-nationale.fr/static/openData/repository"
    return (
        f"{base}/{legislature}/amo/deputes_actifs_mandats_actifs_organes_divises/"
        "AMO40_deputes_actifs_mandats_actifs_organes_divises.json.zip"
    )


# --------------------------------------------------------------------------- #
# Téléchargement
# --------------------------------------------------------------------------- #

def download(url: str) -> bytes:
    LOG.info("Téléchargement de %s", url)
    req = Request(url, headers={"User-Agent": "votes-an-updater/1.0"})
    with urlopen(req, timeout=120) as resp:
        data = resp.read()
    LOG.info("Téléchargé %.1f Mo", len(data) / 1_000_000)
    return data


# --------------------------------------------------------------------------- #
# Normalisation des structures JSON de l'AN
# --------------------------------------------------------------------------- #
# Particularité connue du jeu de données : un nœud qui peut contenir
# plusieurs éléments est sérialisé comme une liste s'il y en a plusieurs,
# mais comme un objet unique (pas de liste) s'il n'y en a qu'un seul.
# `as_list` uniformise ce comportement.

def as_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def to_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


# --------------------------------------------------------------------------- #
# Référentiel des groupes politiques (sigle / nom lisible)
# --------------------------------------------------------------------------- #

def extract_organe_label(raw: dict) -> tuple[str, dict] | None:
    """À partir d'un fichier JSON 'organe', renvoie (uid, {sigle, nom}) si
    c'est un groupe politique (codeType == 'GP'), sinon None."""
    organe = raw.get("organe", raw)
    if not isinstance(organe, dict):
        return None
    if organe.get("codeType") != "GP":
        return None
    uid = organe.get("uid")
    if not uid:
        return None
    sigle = organe.get("libelleAbrege") or organe.get("libelleAbrev") or uid
    nom = organe.get("libelle") or sigle
    return uid, {"sigle": sigle, "nom": nom}


def build_organe_labels(legislature: int) -> dict[str, dict]:
    """Télécharge l'archive des organes et construit le mapping
    organeRef -> {sigle, nom} pour les seuls groupes politiques."""
    url = build_organes_zip_url(legislature)
    zip_bytes = download(url)
    labels: dict[str, dict] = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if not name.lower().endswith(".json"):
                continue
            with zf.open(name) as f:
                try:
                    raw = json.load(io.TextIOWrapper(f, encoding="utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
            result = extract_organe_label(raw)
            if result:
                uid, label = result
                labels[uid] = label
    LOG.info("%d groupes politiques référencés", len(labels))
    return labels


def load_organe_labels(legislature: int, cache_path: Path) -> dict[str, dict]:
    """Récupère le référentiel des groupes, avec repli sur un cache local
    si le téléchargement échoue (le référentiel change rarement)."""
    try:
        labels = build_organe_labels(legislature)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(labels, ensure_ascii=False), encoding="utf-8")
        return labels
    except Exception as exc:  # réseau indisponible, archive absente, etc.
        LOG.warning("Impossible de récupérer le référentiel des groupes (%s)", exc)
        if cache_path.exists():
            LOG.info("Utilisation du cache local %s", cache_path)
            return json.loads(cache_path.read_text(encoding="utf-8"))
        LOG.warning("Aucun cache disponible : les sigles de groupe seront absents")
        return {}


# --------------------------------------------------------------------------- #
# Extraction d'un scrutin
# --------------------------------------------------------------------------- #

def majority_position(pour: int, contre: int, abstentions: int) -> str | None:
    """Résume la position d'un groupe en un mot, à partir de ses décomptes.
    En cas d'égalité, priorité pour > contre > abstention (choix arbitraire
    mais stable, à affiner si besoin pour votre app)."""
    if pour == contre == abstentions == 0:
        return None
    best = max(pour, contre, abstentions)
    if pour == best:
        return "pour"
    if contre == best:
        return "contre"
    return "abstention"


def simplify_scrutin(
    raw: dict,
    organe_labels: dict[str, dict] | None = None,
    with_nominatif: bool = False,
) -> dict | None:
    """Transforme le JSON brut d'un scrutin en enregistrement compact."""
    data = raw.get("scrutin", raw)
    if not isinstance(data, dict):
        return None

    numero = data.get("numero")
    if numero is None:
        return None

    type_vote = data.get("typeVote") or {}
    if isinstance(type_vote, dict):
        type_libelle = type_vote.get("libelleTypeVote") or type_vote.get("codeTypeVote")
    else:
        type_libelle = type_vote

    demandeur = data.get("demandeur") or {}
    if isinstance(demandeur, dict):
        demandeur_texte = demandeur.get("texte")
    else:
        demandeur_texte = demandeur

    sort = data.get("sort") or {}
    sort_code = sort.get("code") if isinstance(sort, dict) else sort

    synthese_raw = data.get("syntheseVote") or {}
    decompte = synthese_raw.get("decompteVoix") or {}
    synthese = {
        "votants": to_int(synthese_raw.get("nombreVotants")),
        "pour": to_int(decompte.get("pour")),
        "contre": to_int(decompte.get("contre")),
        "abstentions": to_int(decompte.get("abstentions")),
        "nonVotants": to_int(
            synthese_raw.get("nonVotants") or decompte.get("nonVotants")
        ),
    }

    record = {
        "numero": to_int(numero),
        "uid": data.get("uid"),
        "date": data.get("dateScrutin"),
        "seance": data.get("numSeanceJour") or data.get("seanceRef"),
        "titre": data.get("titre"),
        "type": type_libelle,
        "demandeur": demandeur_texte,
        "sort": sort_code,
        "synthese": synthese,
        "groupes": [],
    }

    ventilation = data.get("ventilationVotes") or {}
    organe = ventilation.get("organe") or {}
    groupes_node = organe.get("groupes") or {}
    organe_labels = organe_labels or {}
    for groupe in as_list(groupes_node.get("groupe")):
        organe_ref = groupe.get("organeRef")
        vote = groupe.get("vote") or {}
        g_decompte = vote.get("decompteVoix") or {}
        pour = to_int(g_decompte.get("pour"))
        contre = to_int(g_decompte.get("contre"))
        abstentions = to_int(g_decompte.get("abstentions"))
        label = organe_labels.get(organe_ref, {})
        groupe_record = {
            "organe": organe_ref,
            "sigle": label.get("sigle", organe_ref),
            "nom": label.get("nom"),
            "effectif": to_int(groupe.get("nombreDeputesGroupe") or vote.get("effectif")),
            "pour": pour,
            "contre": contre,
            "abstentions": abstentions,
            "nonVotants": to_int(g_decompte.get("nonVotants")),
            "position": majority_position(pour, contre, abstentions),
        }

        if with_nominatif:
            nominatif = vote.get("decompteNominatif") or {}
            for position, key in (
                ("pour", "pours"),
                ("contre", "contres"),
                ("abstention", "abstentions"),
                ("nonVotant", "nonVotants"),
            ):
                votants = as_list((nominatif.get(key) or {}).get("votant"))
                if votants:
                    groupe_record.setdefault("nominatif", {})[position] = [
                        v.get("acteurRef") for v in votants if isinstance(v, dict)
                    ]

        record["groupes"].append(groupe_record)

    return record


# --------------------------------------------------------------------------- #
# Lecture de l'archive ZIP
# --------------------------------------------------------------------------- #

def iter_scrutin_files(zip_bytes: bytes):
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".json")]
        LOG.info("%d fichiers JSON trouvés dans l'archive", len(names))
        for name in names:
            with zf.open(name) as f:
                try:
                    yield name, json.load(io.TextIOWrapper(f, encoding="utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    LOG.warning("Fichier illisible ignoré: %s (%s)", name, exc)


# --------------------------------------------------------------------------- #
# Fusion / mise à jour
# --------------------------------------------------------------------------- #

def load_existing(path: Path) -> dict[int, dict]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        LOG.warning("Fichier existant %s illisible, il sera régénéré", path)
        return {}
    return {s["numero"]: s for s in payload.get("scrutins", []) if "numero" in s}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--legislature", type=int, default=17, help="Numéro de législature (défaut: 17, législature courante)")
    parser.add_argument("--output", type=Path, default=Path("data/votes.json"), help="Chemin du fichier de sortie")
    parser.add_argument("--with-nominatif", action="store_true", help="Inclure le détail nominatif (vote de chaque député) — augmente fortement la taille du fichier")
    parser.add_argument("--pretty", action="store_true", help="Indenter le JSON de sortie (debug). Par défaut le fichier est compact.")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    url = build_zip_url(args.legislature)
    zip_bytes = download(url)

    organes_cache = args.output.parent / "organes_cache.json"
    organe_labels = load_organe_labels(args.legislature, organes_cache)

    existing = load_existing(args.output)
    n_before = len(existing)
    n_new = 0
    n_updated = 0
    n_errors = 0

    for name, raw in iter_scrutin_files(zip_bytes):
        try:
            record = simplify_scrutin(
                raw, organe_labels=organe_labels, with_nominatif=args.with_nominatif
            )
        except Exception as exc:  # défensif : une anomalie ne doit jamais interrompre tout le traitement
            LOG.warning("Erreur sur %s: %s", name, exc)
            n_errors += 1
            continue
        if record is None:
            n_errors += 1
            continue

        numero = record["numero"]
        if numero not in existing:
            n_new += 1
        elif existing[numero] != record:
            n_updated += 1
        existing[numero] = record

    scrutins = sorted(existing.values(), key=lambda s: s["numero"])
    output_payload = {
        "meta": {
            "source": url,
            "legislature": args.legislature,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "count": len(scrutins),
        },
        "scrutins": scrutins,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    dump_kwargs: dict[str, Any] = (
        {"indent": 2} if args.pretty else {"separators": (",", ":")}
    )
    args.output.write_text(
        json.dumps(output_payload, ensure_ascii=False, **dump_kwargs),
        encoding="utf-8",
    )

    LOG.info(
        "Terminé: %d scrutins au total (%d avant, %d nouveaux, %d mis à jour, %d ignorés) -> %s",
        len(scrutins), n_before, n_new, n_updated, n_errors, args.output,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
