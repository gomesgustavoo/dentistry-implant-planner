const support = '<a href="mailto:support@dicomsegvr.com">support@dicomsegvr.com</a>';
const note = (extra: string) => `<p class="legal__note"><strong>Documento em linguagem simples.</strong> Ele descreve o que o serviço de fato faz. Não foi revisado por um advogado e não constitui aconselhamento jurídico.${extra}</p>`;

export const legal = {
  privacy: {
    title: 'Política de Privacidade',
    description: 'Como o ImplantPlan trata os exames de CBCT que você envia, por quanto tempo os resultados são mantidos e quem processa os seus dados.',
    html: `
<h1>Política de Privacidade</h1>
<p class="legal__meta">Última atualização: 29 de setembro de 2026 · dentistry.dicomsegvr.com</p>
${note(' Se você trata dados de pacientes sob a LGPD, o GDPR (RGPD europeu) ou a HIPAA, peça ao seu próprio assessor que revise este documento e formalize um contrato adequado antes de enviar qualquer coisa.')}

<h2>1. O que tratamos</h2>
<p>Duas coisas: as <strong>imagens que você envia</strong> (uma CBCT odontológica, como arquivo ZIP DICOM ou volume NIfTI) e os <strong>dados da conta</strong> fornecidos pelo seu login, que são um identificador, um endereço de e-mail e um nome de usuário. Os pagamentos são processados inteiramente pela Stripe; armazenamos apenas uma referência de cliente, nunca dados de cartão.</p>

<h2>2. As imagens não são anonimizadas por nós</h2>
<p>Uma série DICOM traz identificadores do paciente nos seus cabeçalhos. Lemos apenas a geometria de que precisamos e não indexamos, pesquisamos nem compartilhamos esses cabeçalhos, mas também não os removemos. Não presuma que um exame enviado por você foi anonimizado. <strong>Anonimize-o antes do envio se as suas obrigações assim exigirem.</strong></p>

<h2>3. Por quanto tempo mantemos</h2>
<ul>
<li><strong>O seu envio é excluído assim que o respectivo job termina.</strong> Ele nunca volta a ser lido, portanto não há motivo para mantê-lo.</li>
<li><strong>Os resultados expiram 72 horas após a conclusão</strong> e são removidos do disco. Depois disso, o endpoint de download responde <em>410 Gone</em>.</li>
<li>O registro do job (tempos, volumes das estruturas e achados de qualidade, sem nenhuma imagem) é mantido para que a sua contagem de uso e o seu histórico permaneçam corretos.</li>
<li>Os casos de exemplo são dados públicos de pesquisa e não expiram.</li>
</ul>

<h2>4. Separação entre contas</h2>
<p>Cada caso é armazenado sob a sua própria conta, e cada requisição é verificada em relação à conta que é dona dele. Uma requisição pelo caso de outra conta é respondida como se o caso não existisse.</p>

<h2>5. Sem rastreadores</h2>
<p>Não há ferramentas de análise nem pixels de publicidade, e as fontes são hospedadas por nós mesmos. Dois terceiros participam da entrega deste site: a Cloudflare, que o serve e pode adicionar um pequeno script que protege endereços de e-mail contra robôs de spam, e o YouTube, cujo player de vídeo é carregado a partir de youtube-nocookie.com somente quando você clica em reproduzir (a imagem de pré-visualização exibida antes disso vem de i.ytimg.com). O login usa o nosso próprio serviço de identidade; o seu token de sessão fica na aba do navegador e é descartado quando você a fecha.</p>

<h2>6. Operadores que utilizamos</h2>
<ul>
<li><strong>Stripe</strong>: pagamentos e gestão de assinaturas.</li>
<li><strong>Cloudflare</strong>: terminação TLS e entrega deste site.</li>
</ul>
<p>A segmentação é executada no nosso próprio hardware. As suas imagens não são enviadas a nenhum terceiro e não são usadas para treinar nada.</p>

<h2>7. Os seus direitos</h2>
<p>Você pode pedir uma cópia do que mantemos sobre você, pedir que corrijamos esses dados ou pedir que excluamos a sua conta e tudo o que estiver nela. A exclusão remove os casos armazenados da conta em uma única operação. Escreva para ${support}.</p>

<h2>8. Onde é executado</h2>
<p>O processamento e o armazenamento ocorrem no Brasil. Se você transferir dados pessoais de outra jurisdição, certifique-se de ter uma base legal para isso.</p>

<h2>9. Alterações</h2>
<p>Alterações relevantes serão anunciadas nesta página, com uma nova data acima. Continuar a usar o serviço depois disso constitui aceitação.</p>

<h2>10. Contato</h2>
<p>${support}</p>`,
  },
  terms: {
    title: 'Termos de Serviço',
    description: 'Os termos de uso do ImplantPlan, uma versão preliminar de pesquisa para segmentação de CBCT odontológica e medição da distância de segurança de implantes.',
    html: `
<h1>Termos de Serviço</h1>
<p class="legal__meta">Última atualização: 29 de setembro de 2026 · dentistry.dicomsegvr.com</p>
${note(' Peça ao seu próprio assessor que o revise antes de se basear nele.')}

<h2>1. O que é este serviço</h2>
<p>O ImplantPlan segmenta automaticamente tomografias computadorizadas de feixe cônico (CBCT) odontológicas e devolve as estruturas anatômicas em arquivos RTSTRUCT, STL e NIfTI. Ele também oferece um visualizador no navegador e ferramentas de planejamento de implantes que medem a distância de segurança entre um implante virtual e a anatomia segmentada.</p>

<h2>2. O que ele não é</h2>
<p>É uma <strong>versão preliminar de pesquisa</strong>. <strong>Não é um dispositivo médico</strong>, não possui aprovação regulatória de nenhuma autoridade e <strong>não é destinado a uso diagnóstico</strong>. Não gera guias cirúrgicos. O seu resultado é um ponto de partida para um profissional clínico qualificado, nunca um substituto dele. Os valores de cinza da CBCT não são unidades Hounsfield calibradas, portanto nada do que ele produz é uma medição de densidade. Você é responsável por revisar cada resultado antes que ele embase qualquer decisão clínica.</p>

<h2>3. Precisão</h2>
<p>Publicamos as medições que de fato conseguimos fazer e declaramos com clareza as que não conseguimos; consulte <a href="/pt-br/engineering/#limits">os limites da pesquisa</a>. Não oferecemos nenhuma garantia de que uma estrutura esteja corretamente identificada, corretamente numerada ou completa. Os achados de qualidade são relatados e nunca corrigidos silenciosamente.</p>

<h2>4. As suas responsabilidades</h2>
<ul>
<li>Você tem o direito de enviar as imagens que envia, bem como qualquer consentimento que elas exijam.</li>
<li>Você anonimiza as imagens quando as suas obrigações assim exigirem.</li>
<li>Você não tenta acessar os dados de outra conta nem contornar os limites de uso.</li>
<li>Você mantém as suas credenciais de login somente para si.</li>
</ul>

<h2>5. Planos e cobrança</h2>
<p>O teste dá direito a 30 segmentações em 14 dias, o que se esgotar primeiro, sem necessidade de cartão de crédito. Os planos pagos são mensais, cobrados antecipadamente por meio da Stripe, e incluem um número definido de segmentações por mês civil. Segmentações não utilizadas não são acumuladas para o mês seguinte. Uma segmentação corresponde a um exame processado pelo pipeline completo; um reprocessamento conta novamente, ao passo que um job que falha, ou que você cancela antes de chegar à GPU, não conta. Você pode cancelar a qualquer momento pela página da sua conta, e o acesso continua até o fim do período pago. Meses parciais não são cobrados proporcionalmente.</p>

<h2>6. Disponibilidade</h2>
<p>A segmentação é executada em uma única GPU, por isso os jobs aguardam em uma fila. Não oferecemos garantia de disponibilidade e podemos tirar o serviço do ar para manutenção. Os resultados expiram após 72 horas, portanto baixe o que precisar.</p>

<h2>7. O modelo e o que a sua licença permite</h2>
<p>A segmentação usa um checkpoint U-Mamba2 ajustado (fine-tuning) no conjunto de dados ToothFairy3. Esse conjunto de dados é disponibilizado sob <strong>CC BY-NC-SA 4.0</strong>, e um modelo treinado nele herda os mesmos termos: atribuição, compartilhamento pela mesma licença e <strong>somente uso não comercial</strong>. Este serviço é uma versão preliminar de pesquisa e é oferecido nesses termos. Os autores originais recebem os créditos nas <a href="/pt-br/engineering/#credits">notas de engenharia</a> e <strong>não endossam este serviço</strong>.</p>

<h2>8. Responsabilidade</h2>
<p>Na máxima extensão permitida por lei, o serviço é fornecido no estado em que se encontra, e a nossa responsabilidade total por qualquer reclamação limita-se aos valores que você pagou nos três meses anteriores ao seu surgimento. Não somos responsáveis por decisões clínicas, perdas indiretas ou perda de dados; mantenha as suas próprias cópias de tudo o que precisar.</p>

<h2>9. Suspensão</h2>
<p>Podemos suspender uma conta que viole estes termos, que coloque em risco o serviço ou outros usuários, ou cujo pagamento falhe.</p>

<h2>10. Alterações e contato</h2>
<p>Alterações relevantes serão anunciadas nesta página, com uma nova data acima. Contato: ${support}.</p>`,
  },
};
