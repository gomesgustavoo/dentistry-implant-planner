import type { Project } from '@dicomsegvr/landing-ui/types';

export const project = {
  "id": "implantplan",
  "name": "ImplantPlan",
  "wordmark": [
    "Implant",
    "Plan"
  ],
  "theme": "light",
  "url": "https://dentistry.dicomsegvr.com",
  "title": "ImplantPlan — Explore the anatomy. Measure the clearance · Gustavo Formento",
  "description": "A dental imaging research project combining AI segmentation, interactive 3D, and implant-clearance measurements that account for model error.",
  "eyebrow": "Dental imaging / AI / Interactive 3D",
  "headline": [
    "Explore the anatomy.",
    "Measure the clearance."
  ],
  "primary": {
    "label": "Open app",
    "href": "/app"
  },
  "trial": "30 segmentations over 14 days. No credit card required.",
  "repo": "https://github.com/gomesgustavoo/dentistry-implant-planner",
  "sibling": {
    "label": "DicomSegVR",
    "href": "https://dicomsegvr.com"
  },
  "poster": "/assets/hero-implant.png",
  "socialImage": "/assets/og-image.a270e3f9.png",
  "favicon": "/assets/favicon-32.png",
  "touchIcon": "/assets/apple-touch-icon.b3503f63.png",
  "sceneLabel": "A measurement you can see",
  "sceneDetail": "An implant seats into a segmented mandible. Scrolling reveals the canal and updates the clearance measurement.",
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
    "description": "Place a fixture, inspect the anatomy, and see how position changes the clearance. The interface shows the measurement and its uncertainty together.",
    "steps": [
      {
        "category": "",
        "title": "Segment the scan",
        "description": "A base network and canal specialist identify dental anatomy from a CBCT volume.",
        "technologies": []
      },
      {
        "category": "",
        "title": "Explore the result",
        "description": "Review synchronized slices and 3D structures. Place and adjust a virtual implant.",
        "technologies": []
      },
      {
        "category": "",
        "title": "Inspect the measurement",
        "description": "Read the clearance after the model-error allowance. Export the geometry and research report.",
        "technologies": []
      }
    ]
  },
  "highlights": [
    {
      "category": "Interaction",
      "title": "Anatomy across three planes.",
      "description": "I connected Cornerstone3D and vtk.js in a browser workspace for synchronized slices, 3D inspection, contour editing, and implant placement.",
      "technologies": [
        "JavaScript",
        "Cornerstone3D",
        "vtk.js"
      ]
    },
    {
      "category": "Machine learning",
      "title": "Models with measured limits.",
      "description": "I fine-tuned a U-Mamba2 base model and trained an anterior canal specialist. The base pipeline scored 0.8965 challenge Dice on a 20-case holdout.",
      "technologies": [
        "PyTorch",
        "nnU-Net",
        "U-Mamba2"
      ]
    },
    {
      "category": "Systems",
      "title": "The number has a pipeline.",
      "description": "Clearance accounts for structure-specific model error. Python geometry, GPU jobs, and browser readouts are checked against one another.",
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
      "allowance": "30 segmentations / month",
      "features": [
        "47 structures and all export formats",
        "RTSTRUCT, STL, NIfTI, browser viewer",
        "Results available for 72 hours"
      ],
      "action": {
        "label": "Start free trial",
        "href": "/app"
      },
      "note": "14-day trial · No card required"
    },
    {
      "name": "Pro",
      "price": "49.99",
      "allowance": "60 segmentations / month",
      "features": [
        "Everything in Explorer",
        "Priority GPU queue",
        "Measurement report for every case"
      ],
      "action": {
        "label": "Choose Pro",
        "href": "/app?plan=clinician"
      },
      "note": "Starts your 14-day trial first"
    },
    {
      "name": "Enterprise",
      "price": "199.99",
      "allowance": "120 segmentations / month",
      "features": [
        "Everything in Pro",
        "Shared case list across your account",
        "Direct support"
      ],
      "action": {
        "label": "Choose Enterprise",
        "href": "/app?plan=enterprise"
      },
      "note": "Contact me about higher volumes"
    }
  ],
  "pricingNote": "The trial ends after 30 segmentations or 14 days, whichever comes first. Uploads are deleted when processing completes; results expire after 72 hours. Unused jobs do not roll over. Cancel from your account.",
  "faq": [
    {
      "question": "What can I upload?",
      "answer": "A DICOM series as a ZIP file, or a NIfTI volume (.nii or .nii.gz), up to 100 MB per upload. DICOM preserves the series references used by RTSTRUCT exports."
    },
    {
      "question": "What does the clearance account for?",
      "answer": "The measured distance is reduced by the relevant structure’s measured inward boundary error before grading. The hero illustrates this using a mesh; the application measures on the volume grid. Research limitations are documented in the engineering notes."
    },
    {
      "question": "Is ImplantPlan a clinical planning tool?",
      "answer": "No. It is a research preview, not a medical device, and does not produce surgical guides. Its ToothFairy3-derived model is licensed CC BY-NC-SA 4.0 for non-commercial use."
    },
    {
      "question": "What happens to my scan?",
      "answer": "The source upload is deleted when the job completes. Results remain available for 72 hours. A failed job, or one cancelled before GPU processing, does not use a segmentation credit."
    }
  ],
  "engineeringIntro": "The models, geometry, evaluation results, and deployment decisions behind ImplantPlan. This notebook preserves the evidence and limitations behind the shorter project overview.",
  "media": {
    "videoId": "-DcNCL3ux3Y",
    "start": 25,
    "title": "Balanço Geral Florianópolis",
    "caption": "My DicomSegVR demonstration appears in the opening of this report about RT Medical, where I work.",
    "language": "Portuguese audio"
  }
} satisfies Project;
