import { NextFunction, Request, Response, Router } from "express";
import Logger from "../../loaders/logger";

import CTFService from "../../services/CTF";
import { UnauthorizedError } from "../../types/httperrors";
import { notImplemented } from "../../util";

export default (): Router => {
  const router = Router({ mergeParams: true });

  router.route("/").get(listCTFs).post(createCTF).all(notImplemented);
  router.route("/:ctfID").get(getCTF).all(notImplemented);
  router.route("/:ctfID/archive").post(archiveCTF).all(notImplemented);
  router.route("/:ctfID/unarchive").post(unarchiveCTF).all(notImplemented);

  return router;
};

const _CTFService = new CTFService();

function createCTF(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    next(
      new UnauthorizedError({
        errorMessage: "Missing authorization",
        errorCode: "error_unauthorized",
      })
    );
  }

  Logger.verbose(`Creating new CTF for team ${req.params.teamID}`);
  Logger.debug(JSON.stringify({ ...req.body }));
  _CTFService
    .createCTF(req.headers.authorization.slice(7), req.params.teamID, req.body)
    .then((ctfDetails) => {
      res.status(201).send(ctfDetails);
    })
    .catch((err) => next(err));
}

function listCTFs(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    next(
      new UnauthorizedError({
        errorMessage: "Missing authorization",
        errorCode: "error_unauthorized",
      })
    );
  }

  Logger.verbose(`Getting list of CTFs for team ${req.params.teamID}`);
  _CTFService
    .listCTFs(req.headers.authorization.slice(7), req.params.teamID, req.body.includeArchived ?? undefined)
    .then((CTFs) => {
      res.status(200).send(CTFs);
    })
    .catch((err) => next(err));
}

function getCTF(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    next(
      new UnauthorizedError({
        errorMessage: "Missing authorization",
        errorCode: "error_unauthorized",
      })
    );
  }

  Logger.verbose(`Getting CTF with ID ${req.params.ctfID} from team ${req.params.teamID}`);
  _CTFService
    .getCTF(req.headers.authorization.slice(7), req.params.teamID, req.params.ctfID)
    .then((CTF) => {
      res.status(200).send(CTF);
    })
    .catch((err) => next(err));
}


function archiveCTF(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    next(
      new UnauthorizedError({
        errorMessage: "Missing authorization",
        errorCode: "error_unauthorized",
      })
    );
  }

  Logger.verbose(`Archiving CTF with ID ${req.params.ctfID} in team ${req.params.teamID}`);
  _CTFService
    .archiveCTF(req.headers.authorization.slice(7), req.params.teamID, req.params.ctfID)
    .then((CTF) => {
      res.status(200).send(CTF);
    })
    .catch((err) => next(err));
}

function unarchiveCTF(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    next(
      new UnauthorizedError({
        errorMessage: "Missing authorization",
        errorCode: "error_unauthorized",
      })
    );
  }

  Logger.verbose(`Unarchiving CTF with ID ${req.params.ctfID} in team ${req.params.teamID}`);
  _CTFService
    .unarchiveCTF(req.headers.authorization.slice(7), req.params.teamID, req.params.ctfID)
    .then((CTF) => {
      res.status(200).send(CTF);
    })
    .catch((err) => next(err));
}