const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');

// URL officielle de la 17e Législature (Scrutins.json.zip)
const ZIP_URL = 'https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip';
const OUTPUT_FILE = path.join(__dirname, 'votes.json');

async function processVotes() {
  try {
    console.log('1. Téléchargement du fichier ZIP des scrutins...');
    const response = await axios.get(ZIP_URL, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    console.log('2. Lecture et extraction des données...');
    const zip = new AdmZip(Buffer.from(response.data));
    const zipEntries = zip.getEntries();

    // Map pour conserver uniquement le scrutin le plus récent par texte/titre
    const derniersScrutinsParTexte = new Map();

    zipEntries.forEach((entry) => {
      if (!entry.isDirectory && entry.entryName.endsWith('.json')) {
        try {
          const raw = entry.getData().toString('utf8');
          const data = JSON.parse(raw);
          const scrutin = data.scrutin;

          if (!scrutin) return;

          // Normalisation du titre ou de la référence du texte pour le regroupement
          const titre = (scrutin.titre || "Scrutin sans titre").trim();
          const numeroScrutin = Number(scrutin.numero || 0);

          const voteData = {
            id: scrutin.uid,
            numero: numeroScrutin,
            titre: titre,
            date: scrutin.dateScrutin,
            codeTypeVote: scrutin.codeTypeVote,
            sort: scrutin.sort?.code || "Non précisé",
            demandeur: scrutin.demandeur?.texte || "",
            syntheseVote: {
              pour: Number(scrutin.syntheseVote?.nombrePour || 0),
              contre: Number(scrutin.syntheseVote?.nombreContre || 0),
              abstention: Number(scrutin.syntheseVote?.nombreAbstentions || 0),
              total: Number(scrutin.syntheseVote?.totalVotants || 0)
            }
          };

          // Si le texte n'a pas encore été vu OU si ce numéro de scrutin est plus récent
          if (!derniersScrutinsParTexte.has(titre)) {
            derniersScrutinsParTexte.set(titre, voteData);
          } else {
            const voteExistant = derniersScrutinsParTexte.get(titre);
            // On compare les numéros de scrutin ou les dates
            if (numeroScrutin > voteExistant.numero) {
              derniersScrutinsParTexte.set(titre, voteData);
            }
          }
        } catch (e) {
          console.error(`Erreur sur le fichier ${entry.entryName}:`, e.message);
        }
      }
    });

    // Conversion de la Map en tableau
    const cleanVotes = Array.from(derniersScrutinsParTexte.values());

    // Tri par date/numéro décroissant (du plus récent au plus ancien)
    cleanVotes.sort((a, b) => b.numero - a.numero);

    console.log(`3. Agrégation terminée : ${cleanVotes.length} textes/lois uniques conservés.`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cleanVotes, null, 2), 'utf8');

    console.log('Succès ! Le fichier votes.json a été mis à jour.');
  } catch (err) {
    console.error('Erreur lors du traitement :', err.message);
    process.exit(1);
  }
}

processVotes();
