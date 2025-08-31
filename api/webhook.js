// =================================================================
// WEBHOOK PARA AGENDAMENTO DE BARBEARIA (VERSÃO PARA LANDBOT)
// =================================================================

const express = require("express");
const admin = require('firebase-admin');
const chrono = require('chrono-node'); // Biblioteca para interpretar datas em texto

const app = express();
app.use(express.json());

// --- CONFIGURAÇÕES GERAIS ---
const CONFIG = {
    firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || '{}'),
    timezone: 'America/Sao_Paulo',
    // A duração padrão agora vem do serviço, mas mantemos um fallback
    serviceDurationMinutes: 60, 
    collections: { 
        schedules: 'Agendamentos', 
        config: 'Horarios',
        services: 'Servicos' // Adicionamos a coleção de serviços
    }
};

// --- INICIALIZAÇÃO DO FIREBASE ---
if (CONFIG.firebaseCreds && Object.keys(CONFIG.firebaseCreds).length > 0) {
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(CONFIG.firebaseCreds) });
        console.log('Firebase Admin SDK inicializado com sucesso.');
    }
} else {
    console.warn('⚠️  Credenciais do Firebase não encontradas.');
}

// --- ROTA DE TESTE (HEALTH CHECK) ---
app.get("/api/webhook", (request, response) => {
    console.log("PING [GET] recebido!");
    return response.status(200).send("Webhook está ativo e pronto para receber POST do Landbot.");
});

// --- ROTA PRINCIPAL DO WEBHOOK ---
app.post("/api/webhook", async (request, response) => {
    const startTime = Date.now();
    const body = request.body;
    console.log("\n🔄 === NOVO REQUEST WEBHOOK (LANDBOT) ===", JSON.stringify(body, null, 2));

    try {
        const { intent, nome, telefone, data_hora_texto, servicoId } = body;
        const db = admin.firestore();
        let responseMessage;

        if (intent === 'agendarHorario') {
            // Usa o chrono-node para extrair a data do texto livre
            const parsedDate = chrono.pt.parseDate(data_hora_texto, new Date(), { forwardDate: true });
            
            if (!parsedDate) {
                responseMessage = "Não consegui entender a data e hora. Por favor, tente um formato como 'amanhã às 15h' ou 'sexta 10:30'.";
            } else {
                const personInfo = { name: nome, phone: telefone };
                // Passamos o ID do serviço para a lógica de agendamento
                const resultPayload = await handleScheduling(personInfo, parsedDate, servicoId, db);
                responseMessage = resultPayload.message;
            }
        } else {
            responseMessage = "Desculpe, só entendo de agendamentos por enquanto.";
        }
        
        const duration = (Date.now() - startTime) / 1000;
        console.log(`⏱️ Tempo de Execução: ${duration.toFixed(2)} segundos`);
        
        // Landbot espera uma resposta com a chave "messages" para exibir ao usuário
        console.log(`📤 RESPOSTA ENVIADA: ${responseMessage}`);
        return response.json({ messages: [{ text: responseMessage }] });

    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.json({ messages: [{ text: "Desculpe, ocorreu um erro interno. Tente novamente." }] });
    }
});

// =================================================================
// LÓGICA DE NEGÓCIOS E FUNÇÕES AUXILIARES
// =================================================================
    
async function handleScheduling(personInfo, requestedDate, servicoId, db) {
    // Validações iniciais
    if (!personInfo.name || !personInfo.phone) return { message: "Faltam seus dados pessoais (nome/telefone)." };
    if (!servicoId) return { message: "Você precisa selecionar um serviço para agendar." };
    if (requestedDate <= new Date()) return { message: "Não é possível agendar no passado. Por favor, escolha uma data e hora futura." };

    // Busca os detalhes do serviço selecionado no Firestore
    const servicoRef = db.collection(CONFIG.collections.services).doc(servicoId);
    const servicoSnap = await getDoc(servicoRef);

    if (!servicoSnap.exists()) {
        return { message: "O serviço selecionado não foi encontrado." };
    }
    const servico = servicoSnap.data();

    // Lógica de verificação usando a duração do serviço
    const businessHoursCheck = await checkBusinessHours(requestedDate, servico.duracaoMinutos, db);
    if (!businessHoursCheck.isOpen) return { message: businessHoursCheck.message };

    const hasConflict = await checkConflicts(requestedDate, servico.duracaoMinutos, db);
    if (hasConflict) return { message: "Este horário já está ocupado. Por favor, escolha outro." };

    // Salva o agendamento
    await saveAppointment(personInfo, requestedDate, servico, db);
    
    const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate);
    return { message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}. Te vejo em breve!` };
}

async function checkBusinessHours(date, duracaoMinutos, db) {
    const dayOfWeek = date.getDay();
    const docRef = doc(db, CONFIG.collections.config, String(dayOfWeek));
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) return { isOpen: false, message: `Desculpe, não funcionamos neste dia.` };
    const dayConfig = docSnap.data();
    
    const timeToDecimal = (str) => { if (!str) return 0; const [h, m] = str.split(':').map(Number); return h + (m || 0) / 60; };
    const requestedTime = date.getHours() + date.getMinutes() / 60;
    const serviceDurationInHours = duracaoMinutos / 60;

    const isWithinHours = (time, start, end) => {
        if (!start || !end) return false;
        return time >= timeToDecimal(start) && (time + serviceDurationInHours) <= timeToDecimal(end);
    };

    if (isWithinHours(requestedTime, dayConfig.InicioManha, dayConfig.FimManha) || isWithinHours(requestedTime, dayConfig.InicioTarde, dayConfig.FimTarde)) {
        return { isOpen: true };
    } else {
        return { isOpen: false, message: "O horário solicitado, considerando a duração do serviço, está fora do nosso expediente." };
    }
}

async function checkConflicts(requestedDate, duracaoMinutos, db) {
    const serviceDurationMs = duracaoMinutos * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;

    // Busca agendamentos em um intervalo de tempo próximo para otimizar a consulta
    const searchStart = new Date(requestedStart - 2 * 60 * 60 * 1000); // 2 horas antes
    const searchEnd = new Date(requestedStart + 2 * 60 * 60 * 1000); // 2 horas depois

    const schedulesRef = collection(db, CONFIG.collections.schedules);
    const q = query(schedulesRef, 
        where('Status', '==', 'Agendado'),
        where('DataHoraISO', '>=', searchStart.toISOString()),
        where('DataHoraISO', '<=', searchEnd.toISOString())
    );
    const snapshot = await getDocs(q);

    for (const doc of snapshot.docs) {
        const existingData = doc.data();
        const existingStart = new Date(existingData.DataHoraISO).getTime();
        const existingEnd = existingStart + (existingData.duracaoMinutos * 60 * 1000);
        
        if (requestedStart < existingEnd && requestedEnd > existingStart) {
            console.log(`💥 CONFLITO ENCONTRADO com agendamento das ${new Date(existingStart).toLocaleTimeString()}`);
            return true; // Conflito encontrado
        }
    }
    return false; // Nenhum conflito
}

async function saveAppointment(personInfo, requestedDate, servico, db) {
    const newAppointment = {
        NomeCliente: personInfo.name,
        TelefoneCliente: personInfo.phone,
        DataHoraISO: requestedDate.toISOString(),
        DataHoraFormatada: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate),
        Status: 'Agendado',
        TimestampAgendamento: new Date().toISOString(),
        servicoId: servico.id,
        servicoNome: servico.nome,
        duracaoMinutos: servico.duracaoMinutos,
    };
    await addDoc(collection(db, CONFIG.collections.schedules), newAppointment);
}

module.exports = app;