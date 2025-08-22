// =================================================================
// WEBHOOK PARA AGENDAMENTO DE BARBEARIA (VERSÃO AVANÇADA E COMPLETA)
// =================================================================

const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// =================================================================
// CONFIGURAÇÕES GERAIS - (ALTERE APENAS AQUI)
// =================================================================
const CONFIG = {
    creds: JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}'),
    sheetId: process.env.SHEET_ID,
    timezone: 'America/Sao_Paulo',
    serviceDurationMinutes: 60,
    sheetNames: {
        schedules: 'Agendamentos Barbearia',
        config: 'Horarios',
    },
    columnNames: {
        clientName: 'NomeCliente',
        clientPhone: 'TelefoneCliente', // Adicionada coluna do telefone
        formattedDate: 'DataHoraFormatada',
        status: 'Status',
        isoDate: 'DataHoraISO',
        timestamp: 'TimestampAgendamento',
    },
    // Contexto para manter a conversa ativa após falha
    contexts: {
        awaitingReschedule: 'aguardando_novo_horario'
    }
};

// =================================================================
// INICIALIZAÇÃO E VALIDAÇÃO
// =================================================================
validateEnvironment();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook da barbearia rodando na porta ${PORT}`));

// =================================================================
// ROTA PRINCIPAL DO WEBHOOK
// =================================================================
app.post("/webhook", async (request, response) => {
    try {
        console.log("\n🔄 === NOVO REQUEST WEBHOOK ===");
        validateRequest(request.body);

        const { intent, parameters, queryText, session, outputContexts } = request.body.queryResult;
        const intentName = intent.displayName;
        
        console.log(`🎯 Intent: ${intentName} | 💬 Texto: "${queryText}"`);

        let resultPayload;

        // Lógica de roteamento baseada na Intent
        if (intentName.startsWith("AgendarHorario")) {
            const dateTimeParam = parameters['date-time'];
            if (!dateTimeParam) return response.json(createResponse("Não entendi a data. Por favor, diga o dia e a hora."));
            
            // Pega os dados do cliente (nome, telefone) dos contextos
            const personInfo = getPersonInfo(outputContexts);
            resultPayload = await handleScheduling(personInfo, dateTimeParam);

        } else if (intentName === "CancelarAgendamento") {
            const personInfo = getPersonInfo(outputContexts);
            resultPayload = await handleCancellation(personInfo);

        } else {
            // Resposta padrão para intents não tratadas pelo webhook
            resultPayload = { success: true, message: "Webhook contatado, mas sem ação definida para esta intent." };
        }
        
        const responseData = createResponse(resultPayload.message);

        // ATIVAÇÃO DO CONTEXTO EM CASO DE FALHA NO AGENDAMENTO
        if (resultPayload.success === false && intentName.startsWith("AgendarHorario")) {
            const personInfo = getPersonInfo(outputContexts);
            const contextName = `${session}/contexts/${CONFIG.contexts.awaitingReschedule}`;
            responseData.outputContexts = [{
                name: contextName,
                lifespanCount: 2, // Mantém o contexto ativo por mais 2 turnos de conversa
                parameters: { 
                    nome: personInfo.name, 
                    telefone: personInfo.phone 
                }
            }];
            console.log(`▶️ Contexto '${CONFIG.contexts.awaitingReschedule}' ativado.`);
        }
        
        console.log(`📤 Resposta Enviada: "${resultPayload.message}"`);
        return response.json(responseData);

    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.json(createResponse("Desculpe, ocorreu um erro interno. Tente novamente."));
    } finally {
        console.log("=== FIM REQUEST ===\n");
    }
});

// =================================================================
// LÓGICA PRINCIPAL DE AGENDAMENTO
// =================================================================
async function handleScheduling(personInfo, dateTimeParam) {
    if (!personInfo.name || !personInfo.phone) {
        return { success: false, message: "Não consegui identificar seu nome e telefone. Poderia informá-los novamente?" };
    }
    
    const requestedDate = extractDateFromDialogflow(dateTimeParam);
    if (!requestedDate) {
        return { success: false, message: "Não consegui entender a data e hora. Tente um formato como 'amanhã às 14h'." };
    }

    if (requestedDate <= new Date()) {
        return { success: false, message: "Não é possível agendar no passado. Por favor, escolha uma data e hora futura." };
    }

    const doc = new GoogleSpreadsheet(CONFIG.sheetId);
    await doc.useServiceAccountAuth(CONFIG.creds);
    await doc.loadInfo();

    const scheduleSheet = doc.sheetsByTitle[CONFIG.sheetNames.schedules];
    const configSheet = doc.sheetsByTitle[CONFIG.sheetNames.config];

    if (!scheduleSheet || !configSheet) throw new Error("Planilhas de agendamento ou configuração não encontradas.");

    const businessHoursCheck = await checkBusinessHours(requestedDate, configSheet);
    if (!businessHoursCheck.isOpen) {
        return { success: false, message: businessHoursCheck.message };
    }

    const hasConflict = await checkConflicts(requestedDate, scheduleSheet);
    if (hasConflict) {
        return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };
    }

    await saveAppointment(personInfo, requestedDate, scheduleSheet);
    
    const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate);
    
    return { success: true, message: `Perfeito, ${personInfo.name}! Seu agendamento foi confirmado para ${formattedDateForUser}. Te vejo em breve!` };
}

// =================================================================
// LÓGICA DE CANCELAMENTO
// =================================================================
async function handleCancellation(personInfo) {
    if (!personInfo.phone) {
        return { success: false, message: "Para cancelar, preciso do seu telefone. Você pode me informar?" };
    }

    console.log(`🔍 Procurando agendamento para cancelar para o telefone: ${personInfo.phone}`);
    
    const doc = new GoogleSpreadsheet(CONFIG.sheetId);
    await doc.useServiceAccountAuth(CONFIG.creds);
    await doc.loadInfo();
    const scheduleSheet = doc.sheetsByTitle[CONFIG.sheetNames.schedules];
    
    const rows = await scheduleSheet.getRows();
    // Filtra agendamentos futuros e "Agendados" do cliente, e pega o mais recente para cancelar
    const appointmentToCancel = rows
        .filter(row => row[CONFIG.columnNames.clientPhone] === personInfo.phone && 
                       row[CONFIG.columnNames.status] === 'Agendado' &&
                       new Date(row[CONFIG.columnNames.isoDate]) > new Date())
        .sort((a, b) => new Date(b[CONFIG.columnNames.isoDate]) - new Date(a[CONFIG.columnNames.isoDate]))[0];

    if (appointmentToCancel) {
        appointmentToCancel[CONFIG.columnNames.status] = 'Cancelado';
        await appointmentToCancel.save();
        console.log(`✅ Agendamento cancelado com sucesso.`);
        const formattedDate = appointmentToCancel[CONFIG.columnNames.formattedDate];
        return { success: true, message: `Tudo bem. Seu agendamento de ${formattedDate} foi cancelado.` };
    } else {
        console.log(`- Nenhum agendamento futuro encontrado.`);
        return { success: false, message: `Não encontrei nenhum agendamento futuro no seu nome para cancelar.` };
    }
}


// =================================================================
// FUNÇÕES UTILITÁRIAS (sem alterações significativas)
// =================================================================

/** Extrai nome e telefone dos contextos do Dialogflow. */
function getPersonInfo(contexts) {
    const info = { name: null, phone: null };
    if (!contexts) return info;

    for (const context of contexts) {
        const params = context.parameters;
        if (params) {
            info.name = info.name || params.person?.name || params.nome;
            info.phone = info.phone || params.telefone || params['phone-number'];
        }
    }
    return info;
}

/** Salva o novo agendamento na planilha. */
async function saveAppointment(personInfo, requestedDate, scheduleSheet) {
    const newRow = {
        [CONFIG.columnNames.clientName]: personInfo.name,
        [CONFIG.columnNames.clientPhone]: personInfo.phone,
        [CONFIG.columnNames.isoDate]: requestedDate.toISOString(),
        [CONFIG.columnNames.formattedDate]: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate),
        [CONFIG.columnNames.status]: 'Agendado',
        [CONFIG.columnNames.timestamp]: new Date().toISOString()
    };
    await scheduleSheet.addRow(newRow);
    console.log(`✅ Agendamento salvo na planilha para: ${personInfo.name} (${personInfo.phone})`);
}

// O restante das funções (checkBusinessHours, checkConflicts, etc.) permanecem as mesmas do seu código original
// já que estavam bem implementadas. Apenas garanta que elas estejam presentes no seu arquivo final.
// Abaixo estão as funções que você já tinha, para garantir a completude:

function extractDateFromDialogflow(param) {
    if (!param) return null;
    let dateString = '';
    if (typeof param === 'string') { dateString = param; } 
    else if (typeof param === 'object' && param !== null) { dateString = param.date_time || param.startDateTime; }
    if (dateString) { const date = new Date(dateString); return isNaN(date.getTime()) ? null : date; }
    return null;
}

async function checkBusinessHours(date, configSheet) {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false });
    const parts = formatter.formatToParts(date);
    const getValue = type => parts.find(p => p.type === type)?.value;
    const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
    const dayOfWeek = dayMap[getValue('weekday')];
    const requestedTime = parseInt(getValue('hour')) + parseInt(getValue('minute')) / 60;
    const dayName = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: CONFIG.timezone }).format(date);
    const configRows = await configSheet.getRows();
    const dayConfig = configRows.find(row => parseInt(row.DiaDaSemana) === dayOfWeek);
    const timeToDecimal = (str) => { if (!str) return 0; const [h, m] = str.split(':').map(Number); return h + (m || 0) / 60; };
    if (!dayConfig || !dayConfig.InicioManha) return { isOpen: false, message: `Desculpe, não funcionamos em ${dayName}.` };
    const isWithinHours = (time, start, end) => time >= timeToDecimal(start) && time < timeToDecimal(end);
    if (isWithinHours(requestedTime, dayConfig.InicioManha, dayConfig.FimManha) || isWithinHours(requestedTime, dayConfig.InicioTarde, dayConfig.FimTarde)) return { isOpen: true };
    const morning = `das ${dayConfig.InicioManha} às ${dayConfig.FimManha}`;
    const afternoon = dayConfig.InicioTarde ? ` e das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}` : '';
    return { isOpen: false, message: `Estamos abertos em ${dayName}, mas nosso horário é ${morning}${afternoon}.` };
}

async function checkConflicts(requestedDate, scheduleSheet) {
    const rows = await scheduleSheet.getRows();
    const serviceDurationMs = CONFIG.serviceDurationMinutes * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;
    for (const row of rows) {
        if (row[CONFIG.columnNames.status] !== 'Agendado') continue;
        const existingDateStr = row[CONFIG.columnNames.isoDate];
        if (!existingDateStr) continue;
        const existingStart = new Date(existingDateStr).getTime();
        const existingEnd = existingStart + serviceDurationMs;
        if ((requestedStart < existingEnd) && (requestedEnd > existingStart)) {
            console.log(`💥 CONFLITO ENCONTRADO com agendamento das ${new Date(existingStart).toISOString()}`);
            return true;
        }
    }
    return false;
}

function createResponse(text) { return { fulfillmentMessages: [{ text: { text: [text] } }] }; }
function validateEnvironment() { if (!process.env.GOOGLE_CREDENTIALS || !process.env.SHEET_ID) { console.error('❌ Variáveis de ambiente faltando.'); process.exit(1); } try { JSON.parse(process.env.GOOGLE_CREDENTIALS); } catch (e) { console.error('❌ GOOGLE_CREDENTIALS não é um JSON válido.'); process.exit(1); } console.log('✅ Variáveis de ambiente configuradas.'); }
function validateRequest(body) { if (!body?.queryResult?.intent?.displayName) { throw new Error("Requisição do Dialogflow inválida."); } }
