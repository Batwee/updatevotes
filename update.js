const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');

// URL de la 16e législature (vous pouvez remplacer 16 par 17 pour la législature actuelle)
const ZIP_URL = 'https://data.assemblee-nationale.fr/static/openData/repository/16/vp/VT_16.json.zip';
const OUTPUT_FILE = path.join(__dirname, 'votes.json');

async function processVotes() {
  try {
    console.log('1. Téléchargement de l archive ZIP...');
    const response = await axios.get(ZIP_URL, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    console.log('2. Lecture et simplification des données...');
    const zip = new AdmZip(Buffer.from(response.data));
    const zipEntries = zip.getEntries();

    const cleanVotes = [];

    zipEntries.forEach((entry) => {
      if (!entry.isDirectory && entry.entryName.endsWith('.json')) {
        try {
          const raw = entry.getData().toString('utf8');
          const data = JSON.parse(raw);
          const scrutin = data.scrutin;

          if (!scrutin) return;

          // Structure simplifiée et allégée pour votre application
          cleanVotes.push({
            id: scrutin.uid,
            numero: scrutin.numero,
            titre: scrutin.titre,
            date: scrutin.dateScrutin,
            codeTypeVote: scrutin.codeTypeVote,
            sort: scrutin.sort?.code, // ex: "adopté", "rejeté"
            demandeur: scrutin.demandeur?.texte,
            syntheseVote: {
              pour: Number(scrutin.syntheseVote?.nombrePour || 0),
              contre: Number(scrutin.syntheseVote?.nombreContre || 0),
              abstention: Number(scrutin.syntheseVote?.nombreAbstentions || 0),
              total: Number(scrutin.syntheseVote?.totalVotants || 0)
            }
          });
        } catch (e) {
          console.error(`Erreur sur ${entry.entryName}:`, e.message);
        }
      }
    });

    // Tri par date décroissante
    cleanVotes.sort((a, b) => new Date(b.date) - new Date(a.date));

    console.log(`3. Sauvegarde de ${cleanVotes.length} scrutins...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(cleanVotes), 'utf8');

    console.log('Succès ! Le fichier votes.json simplifié a été créé.');
  } catch (err) {
    console.error('Erreur :', err.message);
    process.exit(1);
  }
}

processVotes();
