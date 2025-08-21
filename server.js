// Importar as bibliotecas necessárias
const express = require("express");
const app = express();

// Usar o middleware do express para processar o JSON vindo do Dialogflow
app.use(express.json());

// Definir a rota /webhook que vai receber as requisições POST
app.post("/webhook", (request, response) => {
  // Extrair o nome da intenção da requisição
  const intent = request.body.queryResult.intent.displayName;

  // Checar se a intenção é a que queremos (AgendarHorario)
  if (intent === "AgendarHorario") {
    
    // 1. EXTRAIR A DATA DO DIALOGFLOW
    const dateTime = request.body.queryResult.parameters["date-time"];
    
    // 2. FORMATAR A DATA
    const dateObj = new Date(dateTime);
    
    const options = {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo'
    };
    
    const formattedDate = new Intl.DateTimeFormat('pt-BR', options).format(dateObj);
    
    // 3. CONSTRUIR A RESPOSTA
    const responseText = `Perfeito! Seu agendamento está confirmado para ${formattedDate}.`;
    
    const dialogflowResponse = {
      fulfillmentText: responseText
    };
    
    response.json(dialogflowResponse);
    
  } else {
    // Se não for a intenção que esperamos, apenas mande uma resposta padrão
    response.json({ fulfillmentText: "Webhook contactado, mas a intenção não é AgendarHorario." });
  }
});

// Iniciar o servidor para que ele possa receber as requisições
const listener = app.listen(process.env.PORT, () => {
  console.log("Your app is listening on port " + listener.address().port);
});
