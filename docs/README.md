# DashboardX

DashboardX is an AI-powered data analysis engine that converts raw datasets into structured insights, visualizations, and explanations in seconds.

Users upload a dataset (Excel, CSV, or other structured files), and DashboardX automatically performs statistical analysis, detects correlations, and generates a clear analytical report using large language models.

The goal is simple: reduce the friction between **data and understanding**.

---

## Features

- Automatic dataset parsing
- Descriptive statistics generation
- Correlation detection
- AI-generated insights and explanations
- Suggested visualizations
- Structured analytical summaries
- Natural language questioning about datasets

---

## Example Workflow

1. Upload a dataset  
2. System parses and computes statistics  
3. AI analyzes dataset structure and patterns  
4. Insights, charts, and explanations are generated  

Example output includes:

- Dataset summary
- Key insights
- Variable explanations
- Correlation analysis
- Suggested charts
- Analytical conclusions

---

## Tech Stack

Backend:
- Node.js
- Express

Data Processing:
- XLSX parsing
- Statistical analysis functions

AI:
- Claude API (Anthropic)

Infrastructure:
- Multer file uploads
- JSON structured responses

---

## Project Structure


server/
routes/
analytics/
parsers/
prompts/
services/

public/
index.html
styles.css

server.js


---

## Running Locally

Install dependencies:


npm install


Create `.env`:


ANTHROPIC_API_KEY=your_api_key


Start server:


node server.js


Server runs at:


http://localhost:3000


---

## Current Capabilities

DashboardX currently supports:

- Excel dataset uploads
- Automatic statistical summaries
- Correlation detection
- AI-generated analytical reports

---

## Vision

Modern data tools require users to manually build dashboards and interpret charts.

DashboardX aims to replace that workflow with a simple interaction:

**Upload data → receive clear insight.**

Long term, the system evolves into an **AI data analyst** capable of answering questions, exploring datasets conversationally, and generating decision-ready reports.

---

## Status

Early-stage prototype.

Actively being developed.
