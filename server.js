// =================================================================
// WEBHOOK PARA AGENDAMENTO DE BARBEARIA
// =================================================================

// --- Dependências ---
const express = require("express");
const { GoogleSpreadsheet } = require('google-spreadsheet');

// --- Configuração da Aplicação ---
const app = express();
app.use(express.json());

// =================================================================
// CONFIGURAÇÕES GERAIS - (ALTERE APENAS AQUI)
// =================================================================
const CONFIG = {
    // Credenciais e ID da Planilha (puxados do ambiente)
    creds: JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}'),
    sheetId: process.env.SHEET_ID,

    // Configurações de Agendamento
    timezone: 'America/Sao_Paulo', // ATENÇÃO: Use o fuso horário correto do Brasil
    serviceDurationMinutes: 60,

    // Nomes das Planilhas (Sheets)
    sheetNames: {
        schedules: 'Agendamentos Barbearia',
        config: 'Horarios',
    },

    // Mapeamento dos Nomes das Colunas na Planilha "Agendamentos Barbearia"
    // As chaves aqui DEVEM ser idênticas aos cabeçalhos da sua planilha.
    columnNames: {
        clientName: 'NomeCliente',
        formattedDate: 'DataHoraFormatada',
        status: 'Status',
        isoDate: 'DataHoraISO',
        timestamp: 'TimestampAgendamento',
    }
};

// =================================================================
// INICIALIZAÇÃO E VALIDAÇÃO
// =================================================================
validateEnvironment();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook da barbearia rodando na porta ${PORT}`);
    console.log(`🌍 Fuso horário configurado: ${CONFIG.timezone}`);
});

// =================================================================
// ROTA PRINCIPAL DO WEBHOOK (RECEBE DADOS DO DIALOGFLOW)
// =================================================================
app.post("/webhook", async (request, response) => {
    try {
        console.log("\n🔄 === NOVO REQUEST WEBHOOK ===");
        validateRequest(request.body);

        const intent = request.body.queryResult.intent.displayName;
        const parameters = request.body.queryResult.parameters;
        
        console.log(`🎯 Intent: ${intent} | 💬 Texto: "${request.body.queryResult.queryText}"`);
        console.log("📋 Parâmetros Recebidos:", JSON.stringify(parameters, null, 2));

        let result;

        if (intent === "AgendarHorario") {
            const dateTimeParam = parameters['date-time'];
            
            if (!dateTimeParam) {
                console.log("❌ Nenhum parâmetro de data/hora encontrado.");
                return response.json(createResponse("Não entendi a data. Por favor, diga o dia e a hora, como 'amanhã às 15h'."));
            }
            
            const personName = getPersonName(request.body.queryResult.outputContexts) || "Cliente";
            result = await handleScheduling(personName, dateTimeParam);
        } else {
            result = { success: true, message: "Webhook contatado, mas a intenção não é de agendamento." };
        }
        
        console.log(`📤 Resposta Enviada: "${result.message}"`);
        return response.json(createResponse(result.message));

    } catch (error) {
        console.error("❌ Erro CRÍTICO no webhook:", error);
        return response.json(createResponse("Desculpe, ocorreu um erro interno. Por favor, tente novamente."));
    } finally {
        console.log("=== FIM REQUEST ===\n");
    }
});

// =================================================================
// LÓGICA PRINCIPAL DE AGENDAMENTO
// =================================================================
async function handleScheduling(name, dateTimeParam) {
    // 1. Extrair e validar a data do parâmetro do Dialogflow
    const requestedDate = extractDateFromDialogflow(dateTimeParam);
    if (!requestedDate) {
        return { success: false, message: "Não consegui entender a data e hora. Por favor, tente um formato como 'sexta-feira às 9 da manhã' ou 'amanhã às 14 horas'." };
    }
    console.log(`✅ Data extraída com sucesso: ${requestedDate.toISOString()}`);

    // 2. Verificar se a data não está no passado
    if (requestedDate <= new Date()) {
        return { success: false, message: "Não é possível agendar para um horário que já passou. Por favor, escolha uma data e hora futura." };
    }

    // 3. Conectar à Planilha Google Sheets
    const doc = new GoogleSpreadsheet(CONFIG.sheetId);
    await doc.useServiceAccountAuth(CONFIG.creds);
    await doc.loadInfo();

    const scheduleSheet = doc.sheetsByTitle[CONFIG.sheetNames.schedules];
    const configSheet = doc.sheetsByTitle[CONFIG.sheetNames.config];

    if (!scheduleSheet || !configSheet) {
        throw new Error(`Planilhas '${CONFIG.sheetNames.schedules}' ou '${CONFIG.sheetNames.config}' não encontradas.`);
    }

    // 4. Verificar se a barbearia está aberta no horário solicitado
    const businessHoursCheck = await checkBusinessHours(requestedDate, configSheet);
    if (!businessHoursCheck.isOpen) {
        return { success: false, message: businessHoursCheck.message };
    }

    // 5. Verificar se o horário já está ocupado
    const hasConflict = await checkConflicts(requestedDate, scheduleSheet);
    if (hasConflict) {
        return { success: false, message: "Este horário já está ocupado. Por favor, escolha outro." };
    }

    // 6. Salvar o agendamento na planilha
    await saveAppointment(name, requestedDate, scheduleSheet);
    
    // 7. Formatar a mensagem de sucesso para o usuário
    const formattedDateForUser = new Intl.DateTimeFormat('pt-BR', { 
        dateStyle: 'full', 
        timeStyle: 'short', 
        timeZone: CONFIG.timezone 
    }).format(requestedDate);
    
    return { success: true, message: `Perfeito, ${name}! Seu agendamento foi confirmado para ${formattedDateForUser}.` };
}

// =================================================================
// FUNÇÕES UTILITÁRIAS
// =================================================================

/** Extrai um objeto Date do parâmetro vindo do Dialogflow. */
function extractDateFromDialogflow(param) {
    if (!param) return null;

    let dateString = '';
    if (typeof param === 'string') {
        dateString = param;
    } else if (typeof param === 'object' && param !== null) {
        dateString = param.date_time || param.startDateTime || param.start;
    }
    
    if (dateString) {
        const date = new Date(dateString);
        return isNaN(date.getTime()) ? null : date;
    }
    return null;
}

/** Verifica se a data e hora solicitadas estão dentro do horário de funcionamento. */
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

    const timeToDecimal = (str) => {
        if (!str) return 0;
        const [hours, minutes] = str.split(':').map(Number);
        return hours + (minutes || 0) / 60;
    };
    
    if (!dayConfig || !dayConfig.InicioManha) {
        return { isOpen: false, message: `Desculpe, não funcionamos em ${dayName}.` };
    }
    
    const isWithinHours = (time, start, end) => time >= timeToDecimal(start) && time < timeToDecimal(end);

    if (isWithinHours(requestedTime, dayConfig.InicioManha, dayConfig.FimManha) || isWithinHours(requestedTime, dayConfig.InicioTarde, dayConfig.FimTarde)) {
        return { isOpen: true };
    } else {
        const morningHours = `das ${dayConfig.InicioManha} às ${dayConfig.FimManha}`;
        const afternoonHours = dayConfig.InicioTarde ? ` e das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}` : '';
        return { isOpen: false, message: `Estamos abertos em ${dayName}, mas nosso horário é ${morningHours}${afternoonHours}.` };
    }
}

/** Verifica se o horário solicitado sobrepõe algum agendamento existente. */
async function checkConflicts(requestedDate, scheduleSheet) {
    console.log("🔍 Verificando conflitos de horário...");
    const rows = await scheduleSheet.getRows();
    const serviceDurationMs = CONFIG.serviceDurationMinutes * 60 * 1000;
    const requestedStart = requestedDate.getTime();
    const requestedEnd = requestedStart + serviceDurationMs;

    console.log(`- Horário solicitado: de ${new Date(requestedStart).toISOString()} a ${new Date(requestedEnd).toISOString()}`);

    for (const row of rows) {
        // Usa o nome da coluna do objeto CONFIG para ler a data
        const existingDateStr = row[CONFIG.columnNames.isoDate];
        if (!existingDateStr) continue;
        
        const existingDate = new Date(existingDateStr);
        if (isNaN(existingDate.getTime())) continue;
        
        const existingStart = existingDate.getTime();
        const existingEnd = existingStart + serviceDurationMs;

        // Lógica de sobreposição: um intervalo se sobrepõe a outro se ele começa antes do outro terminar,
        // e termina depois do outro começar.
        const hasOverlap = (requestedStart < existingEnd) && (requestedEnd > existingStart);
        
        if (hasOverlap) {
            console.log(`💥 CONFLITO ENCONTRADO com agendamento das ${existingDate.toISOString()}`);
            return true; // Conflito encontrado
        }
    }
    
    console.log("✅ Nenhum conflito encontrado. Horário disponível.");
    return false; // Nenhum conflito
}

/** Salva o novo agendamento na planilha. */
async function saveAppointment(name, requestedDate, scheduleSheet) {
    const newRow = {
        [CONFIG.columnNames.clientName]: name,
        [CONFIG.columnNames.isoDate]: requestedDate.toISOString(),
        [CONFIG.columnNames.formattedDate]: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: CONFIG.timezone }).format(requestedDate),
        [CONFIG.columnNames.status]: 'Agendado',
        [CONFIG.columnNames.timestamp]: new Date().toISOString()
    };
    await scheduleSheet.addRow(newRow);
    console.log(`✅ Agendamento salvo na planilha para: ${name}`);
}

/** Extrai o nome da pessoa dos contextos do Dialogflow. */
function getPersonName(contexts) {
    if (!contexts) return null;
    for (const context of contexts) {
        if (context.parameters?.person?.name) return context.parameters.person.name;
        if (context.parameters?.name) return context.parameters.name;
    }
    return null;
}

/** Cria o objeto de resposta padrão para o Dialogflow. */
function createResponse(text) {
    return {
        fulfillmentMessages: [{ text: { text: [text] } }]
    };
}

/** Valida as variáveis de ambiente essenciais. */
function validateEnvironment() {
    if (!process.env.GOOGLE_CREDENTIALS || !process.env.SHEET_ID) {
        console.error('❌ Variáveis de ambiente GOOGLE_CREDENTIALS ou SHEET_ID faltando.');
        process.exit(1);
    }
    try {
        JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch (e) {
        console.error('❌ GOOGLE_CREDENTIALS não é um JSON válido.');
        process.exit(1);
    }
    console.log('✅ Variáveis de ambiente configuradas corretamente.');
}

/** Valida a estrutura básica da requisição do Dialogflow. */
function validateRequest(body) {
    if (!body?.queryResult?.intent?.displayName) {
        throw new Error("Requisição do Dialogflow inválida ou incompleta.");
    }
}
