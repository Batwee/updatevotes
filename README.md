# 🏛️ Assemblée Nationale - API Votes (JSON)

Ce projet permet de récupérer, transformer et simplifier l'ensemble des données de scrutins de l'Assemblée Nationale française (issue des archives officielles au format ZIP) pour les mettre à disposition sous la forme d'un **unique fichier JSON léger, structuré et facile à requêter**.

Le workflow s'exécute automatiquement via GitHub Actions pour maintenir les données à jour.

---

## 🛠️ Modifications apportées au projet

1. **Extraction automatique depuis l'archive ZIP officielle** :
   - Plutôt que d'effectuer des milliers de requêtes réseau individuelles, le script télécharge directement l'archive complète des votes (`VT_16.json.zip` ou `VT_17.json.zip`).
   - Traitement et parsing en mémoire des ~8 400 fichiers JSON contenus dans le ZIP.

2. **Nettoyage et simplification de la structure** :
   - Filtrage des données inutiles pour réduire drastiquement la taille du fichier final.
   - Restructuration des objets autour d'un format minimaliste pour les applications : `id`, `numero`, `titre`, `date`, `sort` et `syntheseVote` (`pour`, `contre`, `abstention`, `total`).
   - Tri automatique des scrutins du plus récent au plus ancien.

3. **Automatisation via GitHub Actions (`.github/workflows/update.yml`)** :
   - Création d'une tâche planifiée (`cron`) quotidienne à 03h00 UTC.
   - Exécution manuelle possible depuis l'onglet *Actions* (`workflow_dispatch`).
   - Réenregistrement automatique du fichier `votes.json` mis à jour directement sur le dépôt.

---

## 🚀 Comment consommer l'API dans ton application ?

Tu n'as pas besoin de serveur backend supplémentaire. Tu peux requêter directement le fichier `votes.json` généré sur la branche `main`.

### URL du Fichier JSON

* **Via jsDelivr CDN (Recommandé - rapide & support CORS)** :
  ```text
  [https://cdn.jsdelivr.net/gh/Batwee/updatevotes@main/votes.json](https://cdn.jsdelivr.net/gh/Batwee/updatevotes@main/votes.json)
