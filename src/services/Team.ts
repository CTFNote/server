import { randomBytes } from "crypto";
import jsonWebToken from "jsonwebtoken";

import { TeamModel, ITeamModel } from "../models/Team";
import { IUserModel, UserModel } from "../models/User";
import {
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from "../types/httperrors";
import {
  BasicInvite,
  InviteOptions,
  TeamDetailsUpdateData,
} from "../types";
import config from "../config";
import Logger from "../loaders/logger";
import { ITeamInviteModel, TeamInviteModel } from "../models/TeamInvite";
import { basicInvite, verifyJWT } from "../util";

export default class TeamService {
  /**
   * create a new team
   *
   * @param {string} jwt the JWT of the user creating the team
   * @param {string} teamName the name of the team
   * @returns {Promise<{ teamName: string; teamID: string }>} returns the team data
   * @memberof TeamService
   */
  public async createTeam(
    jwt: string,
    teamName: string
  ): Promise<{ teamName: string; teamID: string }> {
    Logger.verbose("Creating new team");
    // TODO: Turn this into a proper type

    const teamExists = await TeamModel.exists({
      name: teamName.toLowerCase(),
    }).then();

    if (teamExists) {
      Logger.debug("Team already exists");
      throw new ConflictError({ errorCode: "error_team_exists" });
    }

    const decodedJWT = verifyJWT(jwt);

    const owner = await UserModel.findById(decodedJWT.id).then();
    Logger.debug({ owner });

    Logger.silly("Creating new team");
    const team = await TeamModel.create({
      name: teamName.toLowerCase(),
      owner,
      members: undefined,
      socials: undefined,
      CTFs: undefined,
      invites: [],
    }).catch((err) => {
      Logger.error(`Error while creating team: ${err}`);
      throw new InternalServerError();
    });
    Logger.debug({ team });

    Logger.silly("Adding team to owner");
    owner.teams.push(team);

    Logger.silly("Saving owner and team");
    team.save();
    owner.save();

    Logger.silly("Returning basic team details");
    return { teamName: team.name, teamID: team._id };
  }

  /**
   * Get's a team's information. By default only allows to get info if the user is in the team, but admins can always get the team details
   *
   * @async
   * @param {string} jwt the JWT of the user trying to get team details
   * @param {string} teamID the ID of the team that is getting fetched
   * @memberof TeamService
   */
  public async getTeam(jwt: string, teamID: string): Promise<ITeamModel> {
    Logger.verbose("Getting team");
    const decodedJWT = verifyJWT(jwt);

    Logger.silly("Getting user");
    const user = await (await UserModel.findById(decodedJWT.id))
      .execPopulate()
      .then()
      .catch((err) => {
        Logger.error(err);
        throw new InternalServerError();
      });

    Logger.silly("Getting team");
    const team = await TeamModel.findById(teamID);
    if (!team) {
      throw new NotFoundError({ errorCode: "error_team_not_found" });
    }

    Logger.debug({ user, team });

    if (!user.isAdmin) {
      if (!team.inTeam(user)) {
        Logger.verbose("Invalid permissions");
        throw new UnauthorizedError({
          errorCode: "error_invalid_permissions",
        });
      }
    }

    Logger.silly("Returning team");
    return team;
  }

  /**
   * update team details
   *
   * @param {string} jwt the JWT of the user performing the operation
   * @param {string} teamID the id of the team being modified
   * @param {TeamDetailsUpdateData} newDetails the new team details
   * @returns {Promise<ITeamModel>} the new team
   * @memberof TeamService
   */
  public async updateTeam(
    jwt: string,
    teamID: string,
    newDetails: TeamDetailsUpdateData
  ): Promise<ITeamModel> {
    Logger.verbose("Updating team details");
    const team = await this.getTeam(jwt, teamID);
    Logger.debug({ oldTeam: team, newDetails });

    if (newDetails.name) {
      team.name = newDetails.name;
    }

    if (newDetails.socials?.twitter) {
      team.socials.twitter = newDetails.socials.twitter;
    }

    if (newDetails.socials?.website) {
      team.socials.website = newDetails.socials.twitter;
    }

    Logger.debug({ newTeam: team });

    Logger.silly("Saving team");
    await team.save().catch((err) => {
      Logger.warn(err);
      throw new InternalServerError();
    });

    Logger.silly("Returning team");
    return team;
  }

  /**
   * change the team owner
   *
   * @param {string} jwt the JWT of the user performing the operation
   * @param {string} teamID the ID of the team being modified
   * @param {string} newOwnerID the ID of the new owner
   * @returns {Promise<ITeamModel>} the new team
   * @memberof TeamService
   */
  public async updateOwner(
    jwt: string,
    teamID: string,
    newOwnerID: string
  ): Promise<ITeamModel> {
    Logger.silly("Updating team owner");
    const decodedJWT = verifyJWT(jwt);

    let team: ITeamModel;
    let oldOwner: IUserModel;
    let newOwner: IUserModel;

    Logger.silly("Getting team, old owner, and new owner");
    await Promise.all([
      this.getTeam(jwt, teamID),
      UserModel.findById(decodedJWT.id),
      UserModel.findById(newOwnerID),
    ])
      .then(async (results) => {
        console.log(results);

        team = await results[0]
          .populate("owner")
          .populate("members")
          // .populate("CTFs")
          .execPopulate();
        oldOwner = await results[1].populate("teams").execPopulate();
        newOwner = await results[2].populate("teams").execPopulate();
      })
      .catch((err) => {
        throw err;
      });

    Logger.debug({ team, oldOwner, newOwner });

    if (!decodedJWT.isAdmin) {
      if (!team.inTeam(newOwner)) {
        Logger.verbose("New owner not in team");
        throw new BadRequestError({
          errorMessage:
            "New owner must be in team before transfer of ownership",
        });
      }

      if (!team.isOwner(oldOwner)) {
        Logger.verbose(
          "Cannot transfer ownership away from user that isn't owner"
        );
        throw new BadRequestError({
          errorMessage: "Cannot transfer ownership",
          errorCode: "error_user_not_owner",
        });
      }
    }
    team.owner = newOwner;

    Logger.silly("Saving team");
    await team.save();

    Logger.silly("Depopulating team before returning data");
    await team.depopulate("owner").depopulate("members").execPopulate();

    Logger.silly("Returning depopulated data");
    return team;
  }

  /**
   * create an invite to the team
   *
   * @param {string} jwt the JWT of the user performing the operation
   * @param {string} teamID the id of the team being modified
   * @param {InviteOptions} inviteOptions options for the invite
   * @returns {Promise<ITeamInviteModel>} the invite created
   * @memberof TeamService
   */
  public async createInvite(
    jwt: string,
    teamID: string,
    inviteOptions: InviteOptions
  ): Promise<ITeamInviteModel> {
    Logger.verbose("Inviting user to team");
    const decodedJWT = verifyJWT(jwt);

    Logger.silly("Getting user and team");
    let user: IUserModel;
    let team: ITeamModel;
    await Promise.all([
      UserModel.findById(decodedJWT.id),
      TeamModel.findById(teamID),
    ])
      .then((results) => {
        user = results[0];
        team = results[1];
      })
      .catch((err) => {
        throw err;
      });

    Logger.debug({ user, team });

    if (!user.isAdmin) {
      if (!team.isOwner(user)) {
        Logger.verbose("Only the team owner can create invites");
        throw new BadRequestError({
          errorMessage: "Only the team owner can create invites",
          errorCode: "error_invalid_permissions",
        });
      }
    }

    const invite = new TeamInviteModel({
      team: team._id,
      inviteCode: randomBytes(3).toString("hex"),
      expiry: inviteOptions.expiry ? inviteOptions.expiry : undefined,
      maxUses: inviteOptions.maxUses ? inviteOptions.maxUses : undefined,
      createdAt: new Date(),
      createdByUser: user._id,
      uses: [],
    });

    Logger.debug(invite);

    if (!team.invites) {
      team.invites = [];
    }

    Logger.silly("Adding invite to team");
    team.invites.push(invite._id);

    Logger.silly("Saving invite and team");
    await invite.save();
    await team.save();

    Logger.silly("Returning invite");
    return invite;
  }

  /**
   * gets an invite
   *
   * @param {(string | undefined)} jwt the JWT of the user performind the operation, if present
   * @param {string} inviteID the ID of the invite being requested
   * @returns {(Promise<ITeamInviteModel | BasicInvite>)} return either a basic invite for normal users or a complete invite for admins
   * @memberof TeamService
   */
  public async getInvite(
    jwt: string | undefined,
    inviteID: string
  ): Promise<ITeamInviteModel | BasicInvite> {
    Logger.verbose("Fetching invite");
    const invite = await TeamInviteModel.findOne({ inviteCode: inviteID });

    let user: IUserModel;
    if (jwt) {
      const decodedJWT = verifyJWT(jwt);

      user = await UserModel.findById(decodedJWT.id);
    } else {
      Logger.verbose("User is not authenticated");
    }

    if (!user?.isAdmin) {
      if (
        invite.uses.length >= invite.maxUses ||
        new Date() >= new Date(invite.expiry)
      ) {
        Logger.verbose("Invite is expired");
        throw new BadRequestError({ errorCode: "error_expired_invite" });
      }

      Logger.silly("Returning basic invite as user isn't admin");
      return basicInvite(invite);
    }

    Logger.silly("Returning invite");
    return invite;
  }

  /**
   * deletes an invite
   *
   * @param {string} jwt the ID of the user performing the operation
   * @param {string} inviteID the invite to delete's ID
   * @returns {Promise<void>} void
   * @memberof TeamService
   */
  public async deleteInvite(jwt: string, inviteID: string): Promise<void> {
    Logger.verbose("Deleting invite");
    const decodedJWT = verifyJWT(jwt);

    Logger.silly("Getting user and team");
    let user;
    let invite;

    Promise.all([
      UserModel.findById(decodedJWT.id),
      TeamInviteModel.findOne({ inviteCode: inviteID }),
    ])
      .then((results) => {
        user = results[0];
        invite = results[1];
      })
      .catch((err) => {
        throw err;
      });

    Logger.debug({ user, invite });

    if (!invite) {
      throw new NotFoundError({ errorMessage: "Invite not found" });
    }

    const team = invite.team;

    if (!user.isAdmin) {
      if (!team.isOwner(user)) {
        Logger.verbose("Invalid permissions to delete invite");
        throw new BadRequestError({ errorCode: "error_invalid_permissions" });
      }
    }

    Logger.silly("Deleting invite");
    await invite.delete();
  }

  /**
   * uses an invite and adds a user to the team
   *
   * @param {string} jwt the JWT of the user performing the operation. This is the user that will be added to the team
   * @param {string} inviteID the ID of the team in question
   * @returns {Promise<ITeamModel>} the team the user was added to
   * @memberof TeamService
   */
  public async useInvite(jwt: string, inviteID: string): Promise<ITeamModel> {
    Logger.verbose("Using invite and adding user to team");
    const decodedJWT = verifyJWT(jwt);

    Logger.silly("Getting user and invite");
    let user: IUserModel;
    let invite: ITeamInviteModel;

    Promise.all([
      UserModel.findById(decodedJWT.id),
      TeamInviteModel.findOne({ inviteCode: inviteID }),
    ])
      .then((results) => {
        user = results[0];
        invite = results[1];
      })
      .catch((err) => {
        throw err;
      });

    Logger.debug({ user, invite });

    if (!invite) {
      Logger.verbose("Invite doesn't exist");
      throw new NotFoundError({ errorMessage: "Invite not found" });
    }

    const team = invite.team;
    Logger.debug({ team });

    team.members.push(user._id);
    user.teams.push(team._id);
    invite.uses.push(user._id);

    Logger.silly("Saving team, user, and invite");
    Promise.all([team.save(), user.save(), invite.save()])
      .then()
      .catch((err) => {
        throw err;
      });

    Logger.silly("Returning team");
    return team;
  }

  /**
   * removes a user from a team
   *
   * @param {string} jwt the JWT of the user to remove
   * @param {string} teamID the ID of the team
   * @returns {Promise<void>} void
   * @memberof TeamService
   */
  public async leaveTeam(jwt: string, teamID: string): Promise<void> {
    Logger.verbose("User is leaving team");
    const decodedJWT = verifyJWT(jwt);

    Logger.silly("Getting user and team");
    let user: IUserModel;
    let team: ITeamModel;

    Promise.all([UserModel.findById(decodedJWT.id), TeamModel.findById(teamID)])
      .then((results) => {
        user = results[0];
        team = results[1];
      })
      .catch((err) => {
        throw err;
      });

    Logger.debug({ user, team });

    if (!team) {
      Logger.silly("Team doesn't exist");
      throw new NotFoundError({ errorCode: "error_team_not_found" });
    }

    if (team.isOwner(user)) {
      Logger.verbose("Owner of team cannot leave");
      throw new ConflictError({
        errorMessage: "Owner may not leave team",
        details:
          "The owner of a team cannot leave it without first changing the owner to a different member",
      });
    }

    if (!team.inTeam(user)) {
      Logger.verbose("User cannot leave without already being in team");
      throw new ConflictError({
        errorMessage: "Cannot leave team",
        errorCode: "error_not_in_team",
      });
    }

    team.members = team.members.splice(team.members.indexOf(user._id), 1);
    user.teams = user.teams.splice(user.teams.indexOf(team._id), 1);

    Logger.silly("Saving team");
    team.save();
    user.save();

    Logger.silly("Returning void");
    return;
  }

  /**
   * deletes a team. Only the team owner and admins can delete a team
   *
   * @param {string} jwt the JWT of the user performing the operation
   * @param {string} teamID the team to be deleted
   * @returns {Promise<void>} void
   * @memberof TeamService
   */
  public async deleteTeam(jwt: string, teamID: string): Promise<void> {
    Logger.verbose("Deleting team");
    const decodedJWT = verifyJWT(jwt);

    Logger.silly("Getting user and team");
    let user: IUserModel;
    let team: ITeamModel;

    Promise.all([UserModel.findById(decodedJWT.id), TeamModel.findById(teamID)])
      .then((results) => {
        user = results[0];
        team = results[1];
      })
      .catch((err) => {
        throw err;
      });
    Logger.debug({ user, team });

    if (!user.isAdmin) {
      if (!team.isOwner(user)) {
        Logger.verbose("Only the team owner can delete the team");
        throw new BadRequestError({
          errorCode: "error_invalid_permissions",
          errorMessage: "Only the team owner can delete the team",
        });
      }
    }

    user.teams = user.teams.splice(user.teams.indexOf(team._id), 1);

    Logger.silly("Removing team from all users");
    for (const member of team.members) {
      member.teams = member.teams.splice(member.teams.indexOf(team._id), 1);
      member.save();
    }

    Logger.silly("Saving user and team");
    await user.save();
    await team.delete();

    Logger.silly("Returning void");
    return;
  }
}
