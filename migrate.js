// ARQUIVO: migrate.js

const admin = require('firebase-admin');

// ⚠️ IMPORTANTE: Aponte para o seu arquivo de credenciais do SERVIDOR (adminsdk)
// que você usa para o webhook.
const serviceAccount = require("./chatbot-barbearia-638a7-firebase-adminsdk-fbsvc-2907580b3b.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// O ID da sua primeira barbearia. Todos os dados atuais irão para cá.
const BARBEARIA_ID = '01';

// Nomes das suas coleções antigas
const oldCollections = ['Agendamentos', 'Horarios', 'Servicos'];

async function migrateCollection(collectionName) {
  console.log(`Iniciando migração para a coleção: ${collectionName}...`);

  // 1. Lê todos os documentos da coleção antiga
  const oldCollectionRef = db.collection(collectionName);
  const snapshot = await oldCollectionRef.get();

  if (snapshot.empty) {
    console.log(` -> Coleção "${collectionName}" está vazia. Nada a migrar.`);
    return;
  }

  // 2. Cria uma referência para a nova subcoleção
  const newCollectionRef = db.collection('barbearias').doc(BARBEARIA_ID).collection(collectionName);

  // 3. Itera e copia cada documento
  const batch = db.batch();
  snapshot.docs.forEach(doc => {
    const oldData = doc.data();
    const newDocRef = newCollectionRef.doc(doc.id); // Mantém o mesmo ID do documento
    batch.set(newDocRef, oldData);
  });

  // 4. Executa a gravação em lote
  await batch.commit();

  console.log(`✅ Sucesso! ${snapshot.size} documentos migrados de "${collectionName}" para "barbearias/${BARBEARIA_ID}/${collectionName}".`);
}

async function runMigration() {
  try {
    console.log("🚀 INICIANDO MIGRAÇÃO DE DADOS PARA ESTRUTURA MULTI-TENANT 🚀");
    
    // Cria o documento principal da barbearia, se não existir
    await db.collection('barbearias').doc(BARBEARIA_ID).set({
      nome: "Gestão Barbearia (Migrado)",
      criadoEm: new Date()
    }, { merge: true });
    console.log(`-> Documento "barbearias/${BARBEARIA_ID}" garantido.`);

    for (const collectionName of oldCollections) {
      await migrateCollection(collectionName);
    }

    console.log("\n🎉 MIGRAÇÃO CONCLUÍDA COM SUCESSO! 🎉");
    console.log("⚠️ Lembrete: Se desejar, você pode apagar as coleções antigas manualmente no console do Firebase.");

  } catch (error) {
    console.error("❌ ERRO DURANTE A MIGRAÇÃO:", error);
  }
}

// Executa o script
runMigration();