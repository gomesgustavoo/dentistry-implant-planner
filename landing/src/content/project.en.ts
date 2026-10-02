import type { Project } from '@dicomsegvr/landing-ui/types';
import { media } from '../lib/media';

export const project = {
  "id": "implantplan",
  "locale": "en",
  "name": "ImplantPlan",
  "wordmark": [
    "Implant",
    "Plan"
  ],
  "theme": "light",
  "url": "https://dentistry.dicomsegvr.com",
  "title": "ImplantPlan: plan a dental implant with your hands · Gustavo Formento",
  "description": "Implant planning on real CBCT scans, in the browser and on Meta Quest. Every clearance is graded after the model's own measured error is subtracted.",
  "eyebrow": "Dental imaging / AI / Interactive 3D",
  "headline": [
    "Explore the anatomy.",
    "Measure the clearance."
  ],
  "primary": {
    "label": "Open the app",
    "href": "/app"
  },
  "trial": "30 segmentations over 14 days. No credit card required.",
  "repo": "https://github.com/gomesgustavoo/dentistry-implant-planner",
  "sibling": {
    "label": "DicomSegVR",
    "href": "https://dicomsegvr.com"
  },
  "poster": "/assets/hero-implant.png",
  "socialImage": media.og.src,
  "socialImageAlt": "“Plan a dental implant with your hands.” Two hands in ImplantPlan VR hold a translucent jaw, with the implant's clearances labelled on it.",
  "favicon": "/assets/favicon-32.png",
  "touchIcon": "/assets/apple-touch-icon.b3503f63.png",
  "sceneLabel": "A measurement you can see",
  "sceneDetail": "An implant seats into a segmented mandible. As you scroll, the canal appears and the clearance measurement updates.",
  "sceneHint": "Scroll to seat the implant",
  "skills": [
    "Cornerstone3D",
    "vtk.js",
    "U-Mamba2",
    "FastAPI",
    "Three.js"
  ],
  "demo": {
    "title": "Small movements. Visible consequences.",
    "description": "Place an implant, inspect the anatomy, and see how its position changes the clearance. Every measurement is shown together with its error budget.",
    "video": {
      "bar": "ImplantPlan / One real case, three seating depths",
      "badge": "Research preview",
      "src": "/assets/verdict-loop.mp4",
      "poster": "/assets/shots/seeded-clear.jpg",
      "label": "ImplantPlan at three seating depths: TIGHT at 2.55 mm, BREACH at 2.07 mm, and CLEAR at 3.51 mm",
      "caption": "Recorded from the running app. As the implant moves deeper, the measured clearance and its grade change together."
    },
    "steps": [
      {
        "category": "",
        "title": "Segment the scan",
        "description": "A base network and a canal specialist segment the dental anatomy in a CBCT volume.",
        "technologies": []
      },
      {
        "category": "",
        "title": "Explore the result",
        "description": "Review synchronized slices and 3D structures, then place and adjust a virtual implant.",
        "technologies": []
      },
      {
        "category": "",
        "title": "Read the measurement",
        "description": "See each clearance after its error budget is deducted, then export the geometry and the research report.",
        "technologies": []
      }
    ]
  },
  "highlights": [
    {
      "category": "Interaction",
      "title": "Anatomy across three planes.",
      "description": "Cornerstone3D and vtk.js in one browser workspace, for synchronized slices, 3D inspection, contour editing, and implant placement.",
      "technologies": [
        "JavaScript",
        "Cornerstone3D",
        "vtk.js"
      ]
    },
    {
      "category": "Machine learning",
      "title": "Models with measured limits.",
      "description": "I fine-tuned a U-Mamba2 base model on ToothFairy3 and trained an anterior canal specialist. The base pipeline scores 0.8965 challenge Dice on a 20-case held-out set.",
      "technologies": [
        "PyTorch",
        "nnU-Net",
        "U-Mamba2"
      ]
    },
    {
      "category": "Systems",
      "title": "A measurement you can audit.",
      "description": "Each clearance is reduced by the measured error of the structure it is taken to. The Python geometry, the GPU jobs, and the browser readouts are checked against one another.",
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
      "allowance": "40 segmentations / month",
      "features": [
        "All 47 structures and every export format",
        "RTSTRUCT, STL, NIfTI, and the browser viewer",
        "Results available for 72 hours"
      ],
      "action": {
        "label": "Start free trial",
        "href": "/app"
      },
      "note": "14-day trial · No credit card required"
    },
    {
      "name": "Pro",
      "price": "49.99",
      "allowance": "100 segmentations / month",
      "features": [
        "Everything in Explorer",
        "Two and a half times the Explorer volume",
        "An AI-written planning report for every scan, in development: dental status, bone quality and quantity, and the anatomical risks at each site, trained on the ToothFairy4 clinical-report dataset"
      ],
      "action": {
        "label": "Choose Pro",
        "href": "/app?plan=clinician"
      },
      "note": "Starts with the 14-day trial"
    },
    {
      "name": "Enterprise",
      "price": "199.99",
      "allowance": "Unlimited segmentations",
      "features": [
        "Everything in Pro",
        "Unlimited segmentations under fair use",
        "The segmentation model fine-tuned on your own labelled scans, on request",
        "Direct support"
      ],
      "action": {
        "label": "Choose Enterprise",
        "href": "/app?plan=enterprise"
      },
      "note": "Fine-tuning is scoped with you before it starts."
    }
  ],
  "pricingNote": "The trial ends after 30 segmentations or 14 days, whichever comes first. Uploads are deleted as soon as processing completes, and results expire after 72 hours. Unused segmentations do not roll over. You can cancel from your account at any time. Unlimited means fair use: every job shares one GPU, about 98 s per scan, and runs in order.",
  "faq": [
    {
      "question": "What can I upload?",
      "answer": "A DICOM series as a ZIP file, or a NIfTI volume (.nii or .nii.gz), up to 100 MB per upload. Upload DICOM if you need RTSTRUCT exports, because they reference the original series."
    },
    {
      "question": "Which scans work best?",
      "answer": "Dental-field CBCT that covers the jaws. The model was trained on ToothFairy3, whose 512 volumes are all 0.3 mm isotropic dental-field scans. Whole-head scans are outside that distribution, and the results show it."
    },
    {
      "question": "What does the clearance account for?",
      "answer": "Before a clearance is graded, it is reduced by the error budget of the structure it is measured to: that structure's measured inward boundary error (p95) on the held-out set. The 3D scene on this page applies the same method to a display mesh; the application measures on the voxel grid. The limits are documented in the <a href=\"/engineering/#limits\">engineering notes</a>."
    },
    {
      "question": "Is ImplantPlan a clinical planning tool?",
      "answer": "No. It is a research preview, not a medical device, and it does not produce surgical guides. The dataset and model credits are in the <a href=\"/engineering/#credits\">engineering notes</a>."
    },
    {
      "question": "What happens to my scan?",
      "answer": "The uploaded file is deleted as soon as the job completes, and the results remain available for 72 hours. A failed job, or one canceled before GPU processing starts, does not count against your segmentations."
    }
  ],
  "creatorBio": "ImplantPlan brings together my work in model training, medical-image visualization, and interaction design. It is a research project built to make the reasoning behind every measurement visible.",
  "related": {
    "eyebrow": "A related project",
    "title": ["From the browser", "to virtual reality."],
    "text": "DicomSegVR, my other project, explores a different way to interact with medical images."
  },
  "engineeringIntro": "The models, geometry, evaluation, and deployment decisions behind ImplantPlan, with the evidence and the limitations the overview leaves out.",
  "license": {
    "text": "",
    "name": "",
    "href": "",
    "credits": { "label": "Dataset and model credits", "href": "/engineering/#credits" }
  },
  "media": {
    "videoId": "-DcNCL3ux3Y",
    "start": 25,
    "title": "Balanço Geral Florianópolis",
    "caption": "My DicomSegVR demonstration opens this report about RT Medical, where I work.",
    "language": "Portuguese audio",
    "alt": "Still from the Balanço Geral Florianópolis television report"
  },
  "nav": [
    { "label": "The film", "href": "#demo" },
    { "label": "ImplantPlan VR", "href": "/vr/" },
    { "label": "Engineering", "href": "/engineering/" },
    { "label": "Pricing", "href": "#pricing" }
  ],
  "operatingSystem": "Web, Meta Quest"
} satisfies Project;
