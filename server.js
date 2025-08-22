// COLE ESTE CÓDIGO INTEIRO NO server.js
const express = require("express");
const admin = require('firebase-admin');

const app = express();
// Vercel já faz o parse do JSON por padrão, mas é bom garantir.
app.use(express.json());

const CONFIG = {
    firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
    timezone: 'America/Sao_Paulo',
    serviceDurationMinutes: 60,
    collections: {
        schedules: 'Agendamentos',
        config: 'Horarios',
    },
    contexts: {
        awaitingReschedule: 'aguardando_novo_horario'
    }
};

if (CONFIG.firebaseCreds && Object.keys(CONFIG.firebaseCreds).length > 0) {
    // Evita reinicialização em ambientes serverless
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(CONFIG.firebaseCreds)
        });
    }
    console.log('✅ Conectado ao Firebase/Firestore.');
} else {
    console.warn('⚠️  Credenciais do Firebase não encontradas.');
}

app.get("/webhook", (request, response) => {
    console.log("PING recebido!");
    return response.status(200).send("Estou acordado e pronto para agendar (Vercel)!");
});

app.post("/webhook", async (request, response) => {
    const startTime = Date.now();
    try {
        console.log("\n🔄 === NOVO REQUEST WEBHOOK ===");
        
        const body = request.body;
        validateRequest(body);
        
        const { intent, parameters, queryText, session, outputContexts } = body.queryResult;
        const intentName = intent.displayName;
        const db = admin.firestore();
        
        console.log(`🎯 Intent: ${intentName} | 💬 Texto: "${queryText}"`);

        let resultPayload;

        if (intentName.startsWith("AgendarHorario")) {
            const dateTimeParam = parameters['date-time'];
            if (!dateTimeParam) return response.json(createResponse("Não entendi a data."));
            
            const personInfo = getPersonInfo(outputContexts);
            resultPayload = await handleScheduling(personInfo, dateTimeParam, db);

        } else if (intentName === "CancelarAgendamento") {
            const personInfo = getPersonInfo(outputContexts);
            resultPayload = await handleCancellation(personInfo, db);

        } else {
            resultPayload = { success: true, message: "Webhook contatado, mas sem ação definida." };
        }
        
        const responseData = createResponse(resultPayload.message);

        if (resultPayload.success === false && intentName.startsWith("AgendarHorario")) {
            const personInfo = getPersonInfo(outputContexts);
            const contextName = `${session}/contexts/${CONFIG.contexts.awaitingReschedule}`;
            responseData.outputContexts = [{
                name: contextName,
                lifespanCount: 2,
                parameters: { nome: personInfo.name, telefone: personInfo.phone }
            }];
            console.log(`▶️ Contexto '${CONFIG.contexts.awaitingReschedule}' ativado.`);
        }
        
        const duration = (Date.now() - startTime) / 1000;
        console.log(`⏱️ Tempo de Execução: ${duration.toFixed(2)} segundos`);
        console.log(`📤 Resposta Enviada: "${resultPayload.message}"`);
        return response.json(responseData);

    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.json(createResponse("Desculpe, ocorreu um erro interno."));
    } finally {
        console.log("=== FIM REQUEST ===\n");
    }
});

// -- COLE TODAS AS FUNÇÕES AUXILIARES AQUI --
// handleScheduling, checkConflicts, etc. O código delas não muda.

async function handleScheduling(personInfo, dateTimeParam, db) {
    if (!personInfo.name || !personInfo.phone) return { success: false, message: "Não consegui identificar seu nome e telefone. Poderia informá-los novamente?" };
    const requestedDate = extractDateFromDialogflow(dateTimeParam);
    if (!requestedDate) return { success: false, message: "Não consegui entender a data e hora. Tente um formato como 'amanhã às 14h'." };
    if (requestedDate <= new Date()) return { success: false, message: "Não é possível agendar no passado. Por favor, escolha uma data e hora futura." };

    const [businessHoursCheck, hasConflict] = await Promise.all([
        checkBusinessHours(requestedDate, db),
        checkConflicts(requestedDate, db)
    ]);

    if (!businessHoursCheck.isOpen) return { success: false, message: businessHoursCheck.message };
    if (hasConflict) return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };

    await saveAppointment(personInfo, requestedDate, db);
    
    const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate);
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento foi confirmado para ${formattedDateForUser}. Te vejo em breve!` };
}
// E assim por diante, cole todas as outras funções aqui...
// ... (código completo no final da resposta)

module.exports = app;
