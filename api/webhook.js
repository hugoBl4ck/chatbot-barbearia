// =================================================================
// WEBHOOK MULTI-TENANT - VERSÃO FINAL
// =================================================================
const express = require("express");
const admin = require("firebase-admin");
const dayjs = require("dayjs");
const timezone = require("dayjs/plugin/timezone");
const utc = require("dayjs/plugin/utc");
const customParseFormat = require("dayjs/plugin/customParseFormat");
require("dayjs/locale/pt-br");

// Configurar dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.locale("pt-br");

const app = express();
app.use(express.json());

const CONFIG = {
  firebaseCreds: JSON.parse(process.env.FIREBASE_CREDENTIALS || "{}"),
  timezone: "America/Sao_Paulo",
  collections: {
    barbearias: "barbearias",
    schedules: "agendamentos",
    config: "horarios",
    services: "servicos",
  },
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(CONFIG.firebaseCreds),
  });
}

// A função parseDateTime permanece a mesma por enquanto.
function parseDateTime(text) {
  const now = dayjs().tz(CONFIG.timezone);
  const tomorrow = now.add(1, "day");
  text = text.toLowerCase().trim();
  const weekDays = {
    domingo: 0,
    dom: 0,
    segunda: 1,
    seg: 1,
    "segunda-feira": 1,
    terça: 2,
    ter: 2,
    terca: 2,
    "terça-feira": 2,
    "terca-feira": 2,
    quarta: 3,
    qua: 3,
    "quarta-feira": 3,
    quinta: 4,
    qui: 4,
    "quinta-feira": 4,
    sexta: 5,
    sex: 5,
    "sexta-feira": 5,
    sábado: 6,
    sab: 6,
    sabado: 6,
  };
  const getNextWeekday = (targetDay, hour, minute) => {
    const currentDay = now.day();
    let daysToAdd = targetDay - currentDay;
    if (daysToAdd === 0) {
      const timeToday = now.hour(hour).minute(minute).second(0).millisecond(0);
      if (timeToday.isAfter(now)) {
        return timeToday;
      } else {
        daysToAdd = 7;
      }
    } else if (daysToAdd < 0) {
      daysToAdd += 7;
    }
    return now
      .add(daysToAdd, "day")
      .hour(hour)
      .minute(minute)
      .second(0)
      .millisecond(0);
  };
  const patterns = [
    {
      regex:
        /pr[oó]xim[ao]\s+(\w+(?:-feira)?)\s+(?:[aà]s?\s+)?(\d{1,2})(?::(\d{2}))?h?/,
      handler: (match) => {
        const dayName = match[1];
        const hour = parseInt(match[2]);
        const minute = parseInt(match[3] || "0");
        if (weekDays.hasOwnProperty(dayName)) {
          const targetDay = weekDays[dayName];
          let daysToAdd = targetDay - now.day();
          if (daysToAdd <= 0) daysToAdd += 7;
          return now
            .add(daysToAdd, "day")
            .hour(hour)
            .minute(minute)
            .second(0)
            .millisecond(0);
        }
        return null;
      },
    },
    {
      regex: /^(\w+(?:-feira)?)\s+(?:[aà]s?\s+)?(\d{1,2})(?::(\d{2}))?h?$/,
      handler: (match) => {
        const dayName = match[1];
        const hour = parseInt(match[2]);
        const minute = parseInt(match[3] || "0");
        if (weekDays.hasOwnProperty(dayName)) {
          return getNextWeekday(weekDays[dayName], hour, minute);
        }
        return null;
      },
    },
    {
      regex: /(?:amanh[aã]|amanha)\s+(?:[aà]s?)\s+(\d{1,2})(?::(\d{2}))?h?/,
      handler: (match) => {
        const hour = parseInt(match[1]);
        const minute = parseInt(match[2] || "0");
        return tomorrow.hour(hour).minute(minute).second(0).millisecond(0);
      },
    },
    {
      regex: /hoje\s+(?:[aà]s?)\s+(\d{1,2})(?::(\d{2}))?h?/,
      handler: (match) => {
        const hour = parseInt(match[1]);
        const minute = parseInt(match[2] || "0");
        return now.hour(hour).minute(minute).second(0).millisecond(0);
      },
    },
    {
      regex: /^(\d{1,2})(?::(\d{2}))?h?$/,
      handler: (match) => {
        const hour = parseInt(match[1]);
        const minute = parseInt(match[2] || "0");
        let date = now.hour(hour).minute(minute).second(0).millisecond(0);
        if (date.isBefore(now)) {
          date = date.add(1, "day");
        }
        return date;
      },
    },
    {
      regex:
        /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(?:[aà]s?\s+)?(\d{1,2})(?::(\d{2}))?h?/,
      handler: (match) => {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]);
        const year = parseInt(match[3] || now.year());
        const hour = parseInt(match[4]);
        const minute = parseInt(match[5] || "0");
        return dayjs()
          .tz(CONFIG.timezone)
          .year(year)
          .month(month - 1)
          .date(day)
          .hour(hour)
          .minute(minute)
          .second(0)
          .millisecond(0);
      },
    },
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const result = pattern.handler(match);
      if (result) return result;
    }
  }
  return null;
}

app.post("/api/webhook", async (request, response) => {
  const body = request.body;
  console.log(
    "\n🔄 === NOVO REQUEST WEBHOOK ===\n",
    JSON.stringify(body, null, 2)
  );

  try {
    const { intent, nome, telefone, data_hora_texto, servicoId, barbeariaId } =
      body;
    const db = admin.firestore();
    let resultPayload;

    if (!barbeariaId) {
      console.error("❌ Erro: barbeariaId não fornecido no request.");
      return response
        .status(400)
        .json({
          status: "error",
          message: "ID da barbearia não foi fornecido.",
        });
    }

    if (intent === "agendarHorario") {
      const parsedDate = parseDateTime(data_hora_texto);

      if (!parsedDate) {
        resultPayload = {
          success: false,
          message:
            "Não consegui entender a data e hora. Tente algo como 'amanhã às 16h' ou '16:30'.",
        };
      } else {
        const dateForStorage = parsedDate.utc().toDate();
        const dateForValidation = parsedDate.toDate();

        const personInfo = { name: nome, phone: telefone };
        resultPayload = await handleScheduling(
          barbeariaId,
          personInfo,
          dateForStorage,
          dateForValidation,
          servicoId,
          db
        );
      }
    } else if (intent === "cancelarHorario") {
      const personInfo = { phone: telefone };
      resultPayload = await handleCancellation(barbeariaId, personInfo, db);
    } else {
      resultPayload = {
        success: false,
        message: "Desculpe, não entendi sua intenção.",
      };
    }

    const responseData = {
      status: resultPayload.success ? "success" : "error",
      message: resultPayload.message,
    };
    console.log(
      `\n📤 RESPOSTA ENVIADA:\n`,
      JSON.stringify(responseData, null, 2)
    );
    return response.status(200).json(responseData);
  } catch (error) {
    console.error("❌ Erro CRÍTICO no webhook:", error);
    return response
      .status(500)
      .json({ status: "error", message: "Desculpe, ocorreu um erro interno." });
  }
});

async function handleScheduling(
  barbeariaId,
  personInfo,
  requestedDate,
  localTime,
  servicoId,
  db
) {
  if (!personInfo.name || !personInfo.phone)
    return { success: false, message: "Faltam seus dados pessoais." };
  if (!servicoId)
    return { success: false, message: "Você precisa selecionar um serviço." };
  if (requestedDate.getTime() <= new Date().getTime())
    return { success: false, message: "Não é possível agendar no passado." };

  const servicoRef = db
    .collection(CONFIG.collections.barbearias)
    .doc(barbeariaId)
    .collection(CONFIG.collections.services)
    .doc(servicoId);
  const servicoSnap = await servicoRef.get();
  if (!servicoSnap.exists)
    return {
      success: false,
      message: "O serviço selecionado não foi encontrado para esta barbearia.",
    };

  const servico = { id: servicoSnap.id, ...servicoSnap.data() };
  const duracao = servico.duracaoMinutos || 30;

  const businessHoursCheck = await checkBusinessHours(
    barbeariaId,
    localTime,
    duracao,
    db
  );
  if (!businessHoursCheck.isOpen)
    return { success: false, message: businessHoursCheck.message };

  const hasConflict = await checkConflicts(
    barbeariaId,
    requestedDate,
    duracao,
    db
  );
  if (hasConflict) {
    console.log("⚠️ Conflito detectado, buscando horários alternativos...");
    const suggestions = await getAvailableSlots(
      barbeariaId,
      requestedDate,
      duracao,
      db
    );
    return { success: false, message: suggestions };
  }

  await saveAppointment(barbeariaId, personInfo, requestedDate, servico, db);

  const formattedDateForUser = dayjs(requestedDate)
    .tz(CONFIG.timezone)
    .format("dddd, DD [de] MMMM [às] HH:mm");
  return {
    success: true,
    message: `Perfeito, ${personInfo.name}! Seu agendamento de ${servico.nome} foi confirmado para ${formattedDateForUser}.`,
  };
}

async function checkBusinessHours(barbeariaId, date, duracaoMinutos, db) {
  const dayOfWeek = date.getDay();
  const docRef = db
    .collection(CONFIG.collections.barbearias)
    .doc(barbeariaId)
    .collection(CONFIG.collections.config)
    .doc(String(dayOfWeek));
  const docSnap = await docRef.get();
  if (!docSnap.exists || !docSnap.data().aberto)
    return { isOpen: false, message: `Desculpe, não funcionamos neste dia.` };

  const dayConfig = docSnap.data();
  const timeToMinutes = (str) => {
    if (!str) return null;
    const [h, m] = str.split(":").map(Number);
    return h * 60 + (m || 0);
  };

  const requestedStartMinutes = date.getHours() * 60 + date.getMinutes();
  const requestedEndMinutes = requestedStartMinutes + duracaoMinutos;

  const morningStart = timeToMinutes(dayConfig.InicioManha);
  const morningEnd = timeToMinutes(dayConfig.FimManha);
  const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
  const afternoonEnd = timeToMinutes(dayConfig.FimTarde);

  const fitsInMorning =
    morningStart !== null &&
    morningEnd !== null &&
    requestedStartMinutes >= morningStart &&
    requestedEndMinutes <= morningEnd;
  const fitsInAfternoon =
    afternoonStart !== null &&
    afternoonEnd !== null &&
    requestedStartMinutes >= afternoonStart &&
    requestedEndMinutes <= afternoonEnd;

  if (fitsInMorning || fitsInAfternoon) {
    return { isOpen: true };
  } else {
    const morning = dayConfig.InicioManha
      ? `das ${dayConfig.InicioManha} às ${dayConfig.FimManha}`
      : "";
    const afternoon = dayConfig.InicioTarde
      ? ` e das ${dayConfig.InicioTarde} às ${dayConfig.FimTarde}`
      : "";
    return {
      isOpen: false,
      message: `Nosso horário de funcionamento é ${morning}${afternoon}. O serviço solicitado não se encaixa nesse período.`,
    };
  }
}

async function getAvailableSlots(
  barbeariaId,
  requestedDate,
  duracaoMinutos,
  db
) {
  try {
    const requestedDateDayjs = dayjs(requestedDate).tz(CONFIG.timezone);

    let availableSlots = await findAvailableSlotsForDay(
      barbeariaId,
      requestedDateDayjs,
      duracaoMinutos,
      db
    );

    if (availableSlots.length > 0) {
      const dateStr = requestedDateDayjs.format("DD/MM");
      const slotsText = availableSlots.slice(0, 3).join(", ");
      return `Este horário já está ocupado. Que tal um destes para ${dateStr}? ${slotsText}`;
    }

    const tomorrow = requestedDateDayjs.add(1, "day");
    availableSlots = await findAvailableSlotsForDay(
      barbeariaId,
      tomorrow,
      duracaoMinutos,
      db
    );

    if (availableSlots.length > 0) {
      const dateStr = tomorrow.format("DD/MM");
      const slotsText = availableSlots.slice(0, 3).join(", ");
      return `Este horário já está ocupado e não há mais vagas hoje. Que tal para ${dateStr}? Horários: ${slotsText}`;
    }

    return "Este horário já está ocupado. Infelizmente não encontrei horários disponíveis para hoje nem amanhã. Tente outro dia.";
  } catch (error) {
    console.error("Erro ao buscar horários disponíveis:", error);
    return "Este horário já está ocupado. Tente outro horário.";
  }
}

async function findAvailableSlotsForDay(
  barbeariaId,
  dayDate,
  duracaoMinutos,
  db
) {
  const dayOfWeek = dayDate.day();

  const docRef = db
    .collection(CONFIG.collections.barbearias)
    .doc(barbeariaId)
    .collection(CONFIG.collections.config)
    .doc(String(dayOfWeek));
  const docSnap = await docRef.get();
  if (!docSnap.exists || !docSnap.data().aberto) return [];

  const dayConfig = docSnap.data();
  const timeToMinutes = (str) => {
    if (!str) return null;
    const [h, m] = str.split(":").map(Number);
    return h * 60 + (m || 0);
  };

  const morningStart = timeToMinutes(dayConfig.InicioManha);
  const morningEnd = timeToMinutes(dayConfig.FimManha);
  const afternoonStart = timeToMinutes(dayConfig.InicioTarde);
  const afternoonEnd = timeToMinutes(dayConfig.FimTarde);

  const startOfDay = dayDate.startOf("day").toDate();
  const endOfDay = dayDate.endOf("day").toDate();

  const schedulesRef = db
    .collection(CONFIG.collections.barbearias)
    .doc(barbeariaId)
    .collection(CONFIG.collections.schedules);
  const q = schedulesRef
    .where("Status", "==", "Agendado")
    .where("DataHoraISO", ">=", startOfDay.toISOString())
    .where("DataHoraISO", "<=", endOfDay.toISOString());

  const snapshot = await q.get();

  const busySlots = [];
  snapshot.docs.forEach((doc) => {
    const data = doc.data();
    const startTime = dayjs(data.DataHoraISO).tz(CONFIG.timezone);
    const serviceDuration = data.duracaoMinutos || 30;
    const endTime = startTime.add(serviceDuration, "minutes");
    busySlots.push({
      start: startTime.hour() * 60 + startTime.minute(),
      end: endTime.hour() * 60 + endTime.minute(),
    });
  });

  const availableSlots = [];
  const currentTime = dayjs().tz(CONFIG.timezone);
  const isToday = dayDate.isSame(currentTime, "day");

  const addSlotsFromPeriod = (startMinutes, endMinutes) => {
    if (startMinutes === null || endMinutes === null) return;

    for (
      let time = startMinutes;
      time + duracaoMinutos <= endMinutes;
      time += 30
    ) {
      const slotDate = dayDate.hour(Math.floor(time / 60)).minute(time % 60);

      if (isToday && slotDate.isBefore(currentTime.add(1, "hour"))) {
        continue;
      }

      const hasConflict = busySlots.some(
        (busy) => time < busy.end && time + duracaoMinutos > busy.start
      );

      if (!hasConflict) {
        availableSlots.push(slotDate.format("HH:mm"));
      }
    }
  };

  addSlotsFromPeriod(morningStart, morningEnd);
  addSlotsFromPeriod(afternoonStart, afternoonEnd);

  return availableSlots;
}

async function handleCancellation(barbeariaId, personInfo, db) {
  if (!personInfo.phone)
    return {
      success: false,
      message: "Para cancelar, preciso do seu telefone.",
    };
  const schedulesRef = db
    .collection(CONFIG.collections.barbearias)
    .doc(barbeariaId)
    .collection(CONFIG.collections.schedules);
  const q = schedulesRef
    .where("TelefoneCliente", "==", personInfo.phone)
    .where("Status", "==", "Agendado")
    .where("DataHoraISO", ">", new Date().toISOString());
  const snapshot = await q.get();
  if (snapshot.empty)
    return {
      success: false,
      message: `Não encontrei nenhum agendamento futuro no seu telefone.`,
    };

  let count = 0;
  for (const doc of snapshot.docs) {
    await doc.ref.update({ Status: "Cancelado" });
    count++;
  }
  return {
    success: true,
    message: `Tudo certo! Cancelei ${count} agendamento(s) futuro(s) que encontrei.`,
  };
}

async function checkConflicts(barbeariaId, requestedDate, duracaoMinutos, db) {
  const serviceDurationMs = duracaoMinutos * 60 * 1000;
  const requestedStart = requestedDate.getTime();
  const requestedEnd = requestedStart + serviceDurationMs;

  const searchStart = new Date(requestedStart - 2 * 60 * 60 * 1000);
  const searchEnd = new Date(requestedStart + 2 * 60 * 60 * 1000);

  const schedulesRef = db
    .collection(CONFIG.collections.barbearias)
    .doc(barbeariaId)
    .collection(CONFIG.collections.schedules);
  const q = schedulesRef
    .where("DataHoraISO", ">=", searchStart.toISOString())
    .where("DataHoraISO", "<=", searchEnd.toISOString());

  const snapshot = await q.get();

  for (const doc of snapshot.docs) {
    const existingData = doc.data();

    if (existingData.Status !== "Agendado") {
      continue;
    }

    const existingStart = new Date(existingData.DataHoraISO).getTime();
    const existingEnd =
      existingStart + (existingData.duracaoMinutos || 30) * 60 * 1000;

    if (requestedStart < existingEnd && requestedEnd > existingStart) {
      return true;
    }
  }
  return false;
}

async function saveAppointment(
  barbeariaId,
  personInfo,
  requestedDate,
  servico,
  db
) {
  const schedulesRef = db
    .collection(CONFIG.collections.barbearias)
    .doc(barbeariaId)
    .collection(CONFIG.collections.schedules);

  const newAppointment = {
    NomeCliente: personInfo.name,
    TelefoneCliente: personInfo.phone,
    DataHoraISO: requestedDate.toISOString(),
    Status: "Agendado",
    TimestampAgendamento: new Date().toISOString(),
    servicoId: servico.id,
    servicoNome: servico.nome,
    preco: servico.preco,
    duracaoMinutos: servico.duracaoMinutos || 30,
  };
  await schedulesRef.add(newAppointment);
}

module.exports = app;
