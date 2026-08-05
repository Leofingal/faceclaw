import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const paperclipsApp: AppDefinition = {
  appId: "paperclips",
  title: "Paperclips",
  icon: "paperclip",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./paperclips-app.worker"),
      windowId: "paperclips:main",
      title: "Paperclips",
      iconLetter: "P",
      icon: "paperclip",
    }),
};

export default paperclipsApp;
