import type { Project } from '@dicomsegvr/landing-ui/types';
import { media } from '../lib/media';

export const project = {
  "id": "implantplan",
  "locale": "es",
  "name": "ImplantPlan",
  "wordmark": [
    "Implant",
    "Plan"
  ],
  "theme": "light",
  "url": "https://dentistry.dicomsegvr.com",
  "title": "ImplantPlan: planifique un implante dental con sus manos · Gustavo Formento",
  "description": "Planificación de implantes sobre estudios CBCT reales, en el navegador y en Meta Quest. Cada distancia de seguridad se clasifica después de restar el error medido del propio modelo.",
  "eyebrow": "Imagen dental / IA / 3D interactivo",
  "headline": [
    "Explore la anatomía.",
    "Mida la distancia de seguridad."
  ],
  "primary": {
    "label": "Abrir la aplicación",
    "href": "/app"
  },
  "trial": "30 segmentaciones en 14 días. Sin tarjeta de crédito.",
  "repo": "https://github.com/gomesgustavoo/dentistry-implant-planner",
  "sibling": {
    "label": "DicomSegVR",
    "href": "https://dicomsegvr.com"
  },
  "poster": "/assets/hero-implant.png",
  "socialImage": media.og.src,
  "socialImageAlt": "“Plan a dental implant with your hands.” Dos manos en ImplantPlan VR sostienen una mandíbula translúcida, con las distancias de seguridad del implante señaladas sobre ella.",
  "favicon": "/assets/favicon-32.png",
  "touchIcon": "/assets/apple-touch-icon.b3503f63.png",
  "sceneLabel": "Una medición que se puede ver",
  "sceneDetail": "Un implante se asienta en una mandíbula segmentada. Al desplazarse por la página, aparece el conducto y se actualiza la medición de la distancia de seguridad.",
  "sceneHint": "Desplácese para asentar el implante",
  "skills": [
    "Cornerstone3D",
    "vtk.js",
    "U-Mamba2",
    "FastAPI",
    "Three.js"
  ],
  "demo": {
    "title": "Pequeños movimientos. Consecuencias visibles.",
    "description": "Coloque un implante, examine la anatomía y observe cómo su posición modifica la distancia de seguridad. Cada medición se muestra junto con su presupuesto de error.",
    "video": {
      "bar": "ImplantPlan / Un caso real, tres profundidades de asentamiento",
      "badge": "Versión preliminar de investigación",
      "src": "/assets/verdict-loop.mp4",
      "poster": "/assets/shots/seeded-clear.jpg",
      "label": "ImplantPlan con tres profundidades de asentamiento: AJUSTADO a 2,55 mm, INVADE a 2,07 mm y SEGURO a 3,51 mm",
      "caption": "Grabado en la aplicación en funcionamiento. A medida que el implante se profundiza, la distancia de seguridad medida y su calificación cambian a la vez."
    },
    "steps": [
      {
        "category": "",
        "title": "Segmente el estudio",
        "description": "Una red base y una red especialista en conductos segmentan la anatomía dental en un volumen de CBCT.",
        "technologies": []
      },
      {
        "category": "",
        "title": "Explore el resultado",
        "description": "Revise cortes sincronizados y estructuras 3D; después, coloque y ajuste un implante virtual.",
        "technologies": []
      },
      {
        "category": "",
        "title": "Lea la medición",
        "description": "Consulte cada distancia de seguridad una vez descontado su presupuesto de error y, después, exporte la geometría y el informe de investigación.",
        "technologies": []
      }
    ]
  },
  "highlights": [
    {
      "category": "Interacción",
      "title": "La anatomía en tres planos.",
      "description": "Cornerstone3D y vtk.js en un único espacio de trabajo en el navegador, para cortes sincronizados, inspección 3D, edición de contornos y colocación de implantes.",
      "technologies": [
        "JavaScript",
        "Cornerstone3D",
        "vtk.js"
      ]
    },
    {
      "category": "Aprendizaje automático",
      "title": "Modelos con límites medidos.",
      "description": "Ajusté (fine-tuning) un modelo base U-Mamba2 sobre ToothFairy3 y entrené una red especialista en los conductos anteriores. El pipeline base obtiene un Dice del reto de 0,8965 en un conjunto reservado de 20 casos.",
      "technologies": [
        "PyTorch",
        "nnU-Net",
        "U-Mamba2"
      ]
    },
    {
      "category": "Sistemas",
      "title": "Una medición que se puede auditar.",
      "description": "A cada distancia de seguridad se le resta el error medido de la estructura hasta la que se toma. La geometría en Python, los trabajos en GPU y las lecturas del navegador se verifican entre sí.",
      "technologies": [
        "FastAPI",
        "PostgreSQL",
        "k3s",
        "Pruebas de geometría"
      ]
    }
  ],
  "plans": [
    {
      "name": "Explorer",
      "price": "12.99",
      "allowance": "40 segmentaciones / mes",
      "features": [
        "Las 47 estructuras y todos los formatos de exportación",
        "RTSTRUCT, STL, NIfTI y el visor web",
        "Resultados disponibles durante 72 horas"
      ],
      "action": {
        "label": "Iniciar la prueba gratuita",
        "href": "/app"
      },
      "note": "Prueba de 14 días · Sin tarjeta de crédito"
    },
    {
      "name": "Pro",
      "price": "49.99",
      "allowance": "100 segmentaciones / mes",
      "features": [
        "Todo lo de Explorer",
        "Dos veces y media el volumen de Explorer",
        "Un informe de planificación redactado por IA para cada estudio, en desarrollo: estado dental, calidad y cantidad ósea y los riesgos anatómicos de cada sitio, entrenado con el conjunto de informes clínicos ToothFairy4"
      ],
      "action": {
        "label": "Elegir Pro",
        "href": "/app?plan=clinician"
      },
      "note": "Empieza con la prueba de 14 días"
    },
    {
      "name": "Enterprise",
      "price": "199.99",
      "allowance": "Segmentaciones ilimitadas",
      "features": [
        "Todo lo de Pro",
        "Segmentaciones ilimitadas con uso razonable",
        "El modelo de segmentación ajustado con sus propios estudios etiquetados, bajo solicitud",
        "Soporte directo"
      ],
      "action": {
        "label": "Elegir Enterprise",
        "href": "/app?plan=enterprise"
      },
      "note": "El ajuste se define con usted antes de empezar."
    }
  ],
  "pricingNote": "La prueba termina tras 30 segmentaciones o 14 días, lo que ocurra primero. Los archivos subidos se eliminan en cuanto termina el procesamiento, y los resultados caducan a las 72 horas. Las segmentaciones no utilizadas no se acumulan para el mes siguiente. Puede cancelar desde su cuenta en cualquier momento. Ilimitado significa uso razonable: todos los trabajos comparten una GPU, unos 98 s por estudio, y se procesan en orden.",
  "faq": [
    {
      "question": "¿Qué puedo subir?",
      "answer": "Una serie DICOM en un archivo ZIP o un volumen NIfTI (.nii o .nii.gz), de hasta 100 MB por archivo. Suba DICOM si necesita exportaciones RTSTRUCT, porque estas hacen referencia a la serie original."
    },
    {
      "question": "¿Qué estudios funcionan mejor?",
      "answer": "CBCT de campo dental que abarque los maxilares. El modelo se entrenó con ToothFairy3, cuyos 512 volúmenes son todos estudios de campo dental isotrópicos de 0,3 mm. Los estudios de cabeza completa quedan fuera de esa distribución, y los resultados lo reflejan."
    },
    {
      "question": "¿Qué tiene en cuenta la distancia de seguridad?",
      "answer": "Antes de calificar una distancia de seguridad, se le resta el presupuesto de error de la estructura hasta la que se mide: el error de contorno hacia dentro (p95) de esa estructura, medido en el conjunto reservado. La escena 3D de esta página aplica el mismo método a una malla de visualización; la aplicación mide sobre la rejilla de vóxeles. Los límites están documentados en las <a href=\"/es/engineering/#limits\">notas de ingeniería</a>."
    },
    {
      "question": "¿Es ImplantPlan una herramienta de planificación clínica?",
      "answer": "No. Es una versión preliminar de investigación, no es un producto sanitario y no genera guías quirúrgicas. Los créditos del conjunto de datos y del modelo están en las <a href=\"/es/engineering/#credits\">notas de ingeniería</a>."
    },
    {
      "question": "¿Qué ocurre con mi estudio?",
      "answer": "El archivo subido se elimina en cuanto termina el trabajo, y los resultados permanecen disponibles durante 72 horas. Un trabajo fallido, o uno cancelado antes de que empiece el procesamiento en GPU, no se descuenta de sus segmentaciones."
    }
  ],
  "creatorBio": "ImplantPlan reúne mi trabajo en entrenamiento de modelos, visualización de imagen médica y diseño de interacción. Es un proyecto de investigación creado para hacer visible el razonamiento detrás de cada medición.",
  "related": {
    "eyebrow": "Un proyecto relacionado",
    "title": ["Del navegador", "a la realidad virtual."],
    "text": "DicomSegVR, mi otro proyecto, explora una forma distinta de interactuar con las imágenes médicas."
  },
  "engineeringIntro": "Los modelos, la geometría, la evaluación y las decisiones de despliegue detrás de ImplantPlan, con la evidencia y las limitaciones que la presentación general deja fuera.",
  "license": {
    "text": "",
    "name": "",
    "href": "",
    "credits": { "label": "Créditos del conjunto de datos y del modelo", "href": "/es/engineering/#credits" }
  },
  "media": {
    "videoId": "-DcNCL3ux3Y",
    "start": 25,
    "title": "Balanço Geral Florianópolis",
    "caption": "Mi demostración de DicomSegVR abre este reportaje sobre RT Medical, donde trabajo.",
    "language": "Audio en portugués",
    "alt": "Fotograma del reportaje televisivo de Balanço Geral Florianópolis"
  },
  "nav": [
    { "label": "El vídeo", "href": "#demo" },
    { "label": "ImplantPlan VR", "href": "/vr/" },
    { "label": "Ingeniería", "href": "/engineering/" },
    { "label": "Precios", "href": "#pricing" }
  ],
  "operatingSystem": "Web, Meta Quest"
} satisfies Project;
