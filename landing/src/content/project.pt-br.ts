import type { Project } from '@dicomsegvr/landing-ui/types';
import { media } from '../lib/media';

export const project = {
  "id": "implantplan",
  "locale": "pt-br",
  "name": "ImplantPlan",
  "wordmark": [
    "Implant",
    "Plan"
  ],
  "theme": "light",
  "url": "https://dentistry.dicomsegvr.com",
  "title": "ImplantPlan: planeje um implante dentário com as próprias mãos · Gustavo Formento",
  "description": "Planejamento de implantes em exames de CBCT reais, no navegador e no Meta Quest. Cada distância de segurança é classificada depois de subtraído o erro medido do próprio modelo.",
  "eyebrow": "Imagem odontológica / IA / 3D interativo",
  "headline": [
    "Explore a anatomia.",
    "Meça a distância de segurança."
  ],
  "primary": {
    "label": "Abrir o aplicativo",
    "href": "/app"
  },
  "trial": "30 segmentações em 14 dias. Sem cartão de crédito.",
  "repo": "https://github.com/gomesgustavoo/dentistry-implant-planner",
  "sibling": {
    "label": "DicomSegVR",
    "href": "https://dicomsegvr.com"
  },
  "poster": "/assets/hero-implant.png",
  "socialImage": media.og.src,
  "socialImageAlt": "“Plan a dental implant with your hands.” Duas mãos no ImplantPlan VR seguram uma mandíbula translúcida, com as distâncias de segurança do implante indicadas sobre ela.",
  "favicon": "/assets/favicon-32.png",
  "touchIcon": "/assets/apple-touch-icon.b3503f63.png",
  "sceneLabel": "Uma medição que você pode ver",
  "sceneDetail": "Um implante é instalado em uma mandíbula segmentada. Conforme você rola a página, o canal aparece e a medição da distância de segurança é atualizada.",
  "sceneHint": "Role a página para instalar o implante",
  "skills": [
    "Cornerstone3D",
    "vtk.js",
    "U-Mamba2",
    "FastAPI",
    "Three.js"
  ],
  "demo": {
    "title": "Pequenos movimentos. Consequências visíveis.",
    "description": "Posicione um implante, examine a anatomia e veja como a posição dele altera a distância de segurança. Cada medição é exibida junto com o seu orçamento de erro.",
    "video": {
      "bar": "ImplantPlan / Um caso real, três profundidades de instalação",
      "badge": "Versão preliminar de pesquisa",
      "src": "/assets/verdict-loop.mp4",
      "poster": "/assets/shots/seeded-clear.jpg",
      "label": "ImplantPlan em três profundidades de instalação: JUSTO a 2,55 mm, INVADE a 2,07 mm e SEGURO a 3,51 mm",
      "caption": "Gravado a partir do aplicativo em execução. À medida que o implante é aprofundado, a distância de segurança medida e a sua classificação mudam juntas."
    },
    "steps": [
      {
        "category": "",
        "title": "Segmente o exame",
        "description": "Uma rede base e uma rede especialista em canais segmentam a anatomia dentária em um volume de CBCT.",
        "technologies": []
      },
      {
        "category": "",
        "title": "Explore o resultado",
        "description": "Revise cortes sincronizados e estruturas em 3D; depois, posicione e ajuste um implante virtual.",
        "technologies": []
      },
      {
        "category": "",
        "title": "Leia a medição",
        "description": "Veja cada distância de segurança já descontado o seu orçamento de erro e, em seguida, exporte a geometria e o relatório de pesquisa.",
        "technologies": []
      }
    ]
  },
  "highlights": [
    {
      "category": "Interação",
      "title": "Anatomia nos três planos.",
      "description": "Cornerstone3D e vtk.js em um único espaço de trabalho no navegador, com cortes sincronizados, inspeção em 3D, edição de contornos e posicionamento de implantes.",
      "technologies": [
        "JavaScript",
        "Cornerstone3D",
        "vtk.js"
      ]
    },
    {
      "category": "Aprendizado de máquina",
      "title": "Modelos com limites medidos.",
      "description": "Fiz o ajuste fino (fine-tuning) de um modelo base U-Mamba2 no ToothFairy3 e treinei uma rede especialista nos canais anteriores. O pipeline base alcança 0,8965 de Dice do desafio em um conjunto reservado de 20 casos.",
      "technologies": [
        "PyTorch",
        "nnU-Net",
        "U-Mamba2"
      ]
    },
    {
      "category": "Sistemas",
      "title": "Uma medição que você pode auditar.",
      "description": "Cada distância de segurança é reduzida pelo erro medido da estrutura até a qual ela é tomada. A geometria em Python, os jobs na GPU e as leituras no navegador são conferidos uns contra os outros.",
      "technologies": [
        "FastAPI",
        "PostgreSQL",
        "k3s",
        "Geometry tests"
      ]
    }
  ],
  "plans": [
    {
      "name": "Explorer",
      "price": "12.99",
      "allowance": "30 segmentações / mês",
      "features": [
        "Todas as 47 estruturas e todos os formatos de exportação",
        "RTSTRUCT, STL, NIfTI e o visualizador no navegador",
        "Resultados disponíveis por 72 horas"
      ],
      "action": {
        "label": "Começar o teste gratuito",
        "href": "/app"
      },
      "note": "Teste de 14 dias · Sem cartão de crédito"
    },
    {
      "name": "Pro",
      "price": "49.99",
      "allowance": "60 segmentações / mês",
      "features": [
        "Tudo o que o Explorer oferece",
        "O dobro do volume mensal"
      ],
      "action": {
        "label": "Escolher o Pro",
        "href": "/app?plan=clinician"
      },
      "note": "Começa com o teste de 14 dias"
    },
    {
      "name": "Enterprise",
      "price": "199.99",
      "allowance": "120 segmentações / mês",
      "features": [
        "Tudo o que o Pro oferece",
        "Quatro vezes o volume do Explorer",
        "Suporte direto"
      ],
      "action": {
        "label": "Escolher o Enterprise",
        "href": "/app?plan=enterprise"
      },
      "note": "Precisa de mais? Fale comigo sobre volumes maiores."
    }
  ],
  "pricingNote": "O teste termina após 30 segmentações ou 14 dias, o que ocorrer primeiro. Os arquivos enviados são excluídos assim que o processamento termina, e os resultados expiram após 72 horas. Segmentações não utilizadas não são acumuladas para o mês seguinte. Você pode cancelar pela sua conta a qualquer momento.",
  "faq": [
    {
      "question": "O que posso enviar?",
      "answer": "Uma série DICOM em um arquivo ZIP ou um volume NIfTI (.nii ou .nii.gz), com até 100 MB por envio. Envie DICOM se precisar de exportações RTSTRUCT, porque elas fazem referência à série original."
    },
    {
      "question": "Quais exames funcionam melhor?",
      "answer": "CBCT de campo odontológico que abranja os maxilares. O modelo foi treinado no ToothFairy3, cujos 512 volumes são todos exames de campo odontológico isotrópicos de 0,3 mm. Exames de cabeça inteira estão fora dessa distribuição, e os resultados deixam isso evidente."
    },
    {
      "question": "O que a distância de segurança leva em conta?",
      "answer": "Antes de ser classificada, a distância de segurança é reduzida pelo orçamento de erro da estrutura até a qual é medida: o erro de contorno para dentro (p95) dessa estrutura, medido no conjunto reservado. A cena 3D desta página aplica o mesmo método a uma malha de exibição; o aplicativo mede na grade de voxels. Os limites estão documentados nas <a href=\"/pt-br/engineering/#limits\">notas de engenharia</a>."
    },
    {
      "question": "O ImplantPlan é uma ferramenta de planejamento clínico?",
      "answer": "Não. É uma versão preliminar de pesquisa, não é um dispositivo médico e não gera guias cirúrgicos. O seu modelo de segmentação é derivado do ToothFairy3, licenciado sob CC BY-NC-SA 4.0 para uso não comercial."
    },
    {
      "question": "O que acontece com o meu exame?",
      "answer": "O arquivo enviado é excluído assim que o job termina, e os resultados ficam disponíveis por 72 horas. Um job que falha, ou que é cancelado antes de o processamento na GPU começar, não é descontado das suas segmentações."
    }
  ],
  "creatorBio": "O ImplantPlan reúne o meu trabalho em treinamento de modelos, visualização de imagens médicas e design de interação. É um projeto de pesquisa construído para tornar visível o raciocínio por trás de cada medição.",
  "related": {
    "eyebrow": "Um projeto relacionado",
    "title": ["Do navegador", "à realidade virtual."],
    "text": "O DicomSegVR, meu outro projeto, explora uma forma diferente de interagir com imagens médicas."
  },
  "engineeringIntro": "As decisões de modelos, geometria, avaliação e implantação por trás do ImplantPlan, com as evidências e as limitações que a visão geral deixa de fora.",
  "license": {
    "text": "O modelo de segmentação é derivado do conjunto de dados ToothFairy3, licenciado sob",
    "name": "CC BY-NC-SA 4.0",
    "href": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    "credits": { "label": "Créditos do conjunto de dados e dos modelos", "href": "/pt-br/engineering/#credits" }
  },
  "media": {
    "videoId": "-DcNCL3ux3Y",
    "start": 25,
    "title": "Balanço Geral Florianópolis",
    "caption": "A minha demonstração do DicomSegVR abre esta reportagem sobre a RT Medical, onde trabalho.",
    "language": "Áudio em português",
    "alt": "Imagem da reportagem de televisão do Balanço Geral Florianópolis"
  },
  "nav": [
    { "label": "O vídeo", "href": "#demo" },
    { "label": "ImplantPlan VR", "href": "/vr/" },
    { "label": "Engenharia", "href": "/engineering/" },
    { "label": "Preços", "href": "#pricing" }
  ],
  "operatingSystem": "Web, Meta Quest"
} satisfies Project;
