FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 8020
CMD ["node", "-e", "const {IicpNode}=require('./dist/index.js'); const n=new IicpNode({nodeId:'docker-node',endpoint:'http://localhost:8020',intent:'urn:iicp:intent:llm:chat:v1'}); n.serve(async()=>({}),{port:8020});"]
